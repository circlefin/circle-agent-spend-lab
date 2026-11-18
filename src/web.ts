/**
 * Copyright 2026 Circle Internet Group, Inc.  All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

// Local web chat for the research agent: one Bun server and one page (web/index.html).
// Same agent, harness, policy and identity checks as the terminal chat, through src/setup.ts. The page offers Arc sellers only.
// Listens on 127.0.0.1 only. Quote-only is the default; live payments need --live and policy.liveEnabled.
// When the agent buys inference, the person picks the provider on the page; no pick in 120 seconds buys nothing.
// A purchase above the approval threshold waits for Approve on the page; no answer in 120 seconds declines it.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { args, outputFolder, root, save } from './cli';
import { authorize, type Policy } from './policy';
import { Harness } from './harness';
import { invokeAgent } from './agent';
import { loadIdentity, localCompany } from './company';
import { credentialSchema, type Binding, type IdentitySession } from './identity';
import type { Service } from './service';
import { chatSetup, remainingPolicy, withContext, type Turn } from './setup';
import { safrComponents, safrOutcomeNames, safrSource, safrDenial } from './safr';
import { ApprovalBridge, ChoiceBridge, EventTracker, budgetOf, choiceCard, displayReason, earlyRefusalRow, networkLabel, operationLabel, optionLabels, ruleText, type Emit, type RecordRow, type WebEvent } from './web-events';
import { Refusal, errorText, micro, type RecordEntry, type Transport } from './types';

export const localHost = '127.0.0.1';
const defaultPort = 4180;
const approvalTimeoutMs = 120_000;
const choiceTimeoutMs = 120_000;
const turnTimeoutMs = 300_000; // The signed identity session lasts 300 seconds, so a turn must not outlive it.

export type ActAs = 'employee' | 'observer';
// kind 'refusal' marks presets meant to end without a purchase; the identity refusal is enforced by code.
export interface Preset { id: string; label: string; note: string; seller: string; question: string; actAs?: ActAs; kind?: 'refusal' }
// A plain question: with BlockRun.AI selected, the agent buys one model answer and the person picks the provider.
const sampleQuestion = 'Which payment rails and protocols are emerging for AI agents, and how do they compare on speed, cost and use case?';
export const presets: Preset[] = [
  { id: 'inference', label: 'Ask a model, choose the provider', note: 'BlockRun.AI', seller: 'blockrun', question: sampleQuestion },
  { id: 'unassigned', label: 'Ask as an unassigned employee', note: 'Refused by the identity check', seller: 'blockrun', actAs: 'observer', kind: 'refusal', question: sampleQuestion },
];
// The page offers sellers that settle on Arc only.
export const arcSellers = (policy: Policy, sellers: string[]): string[] => sellers.filter(id => /^ARC(?:-|$)/.test(authorize(policy, id).chain));

export const askSchema = z.object({ question: z.string().trim().min(1).max(2000), seller: z.string(), actAs: z.enum(['employee', 'observer']).default('employee') }).strict();
export type AskBody = z.infer<typeof askSchema>;
export const approveSchema = z.object({ approvalId: z.uuid(), decision: z.enum(['approve', 'decline']) }).strict();
// value null cancels the choice; nothing is bought.
export const chooseSchema = z.object({ choiceId: z.uuid(), value: z.string().max(200).nullable() }).strict();

export const companyName = (companyId: string): string => companyId.split('-').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('');

export interface WebChatOptions {
  policy: Policy; live: boolean; sellers: string[]; catalog: Map<string, Service>; model: BaseChatModel;
  company: string; employeeId: string; agentId: string; observerId?: string;
  transport(chain: string): Promise<Transport>;
  // Signs and checks one question as one identity session. Throws a Refusal when identity fails.
  identity(actAs: ActAs, binding: Binding): IdentitySession;
  bridge: ApprovalBridge; choices: ChoiceBridge; directory?: string;
  offline?: boolean; // bun run web:offline: a scripted agent and seller, simulated payments (evals/web-offline.ts).
}

// One chat for the life of the server: one budget, one record list, one question at a time.
export function createWebChat(options: WebChatOptions) {
  const history: Turn[] = []; const records: RecordEntry[] = []; const rows: RecordRow[] = [];
  let reservedMicro = 0, purchases = 0, running = false, halted: string | undefined, current: Harness | undefined;
  const sellerName = (id: string) => options.catalog.get(id)!.definition.name;
  // Includes the running turn's held amount and purchases, if any.
  const budget = (turn: Harness | undefined = current) => budgetOf(options.policy, reservedMicro + (turn?.reservedMicro ?? 0), purchases + (turn?.purchaseCount ?? 0),
    turn ? [...records, ...turn.records] : records);
  // The approval card can appear only when some offered operation's cap is above the approval threshold.
  const { limits } = options.policy;
  const approvalReachable = options.sellers.some(id => Object.values(authorize(options.policy, id).operations)
    .some(rule => micro(rule.maxUsdc ?? limits.perRequestUsdc) > micro(limits.approvalAboveUsdc)));

  function state() {
    return {
      company: options.company, employee: options.employeeId, agent: options.agentId,
      live: options.live, offline: Boolean(options.offline), approvalAboveUsdc: limits.approvalAboveUsdc, approvalReachable, halted: halted ?? null, busy: running,
      sellers: options.sellers.map(id => ({ id, name: sellerName(id) })),
      presets: presets.filter(preset => options.sellers.includes(preset.seller) && (preset.actAs !== 'observer' || options.observerId))
        .map(preset => ({ ...preset, network: networkLabel(authorize(options.policy, preset.seller).chain) })),
      budget: budget(), records: rows,
      // SAFR's terms for the page's panel and tags, from src/safr.ts.
      safr: { source: safrSource, components: Object.entries(safrComponents).map(([id, component]) => ({ id, ...component })), outcomes: safrOutcomeNames },
    };
  }

  async function ask(body: AskBody, emit: Emit, signal?: AbortSignal): Promise<void> {
    if (running) throw new Error('A question is already running');
    running = true;
    try { await turn(body, emit, signal); } finally { running = false; }
  }

  async function turn(body: AskBody, emit: Emit, signal?: AbortSignal): Promise<void> {
    const seller = body.seller;
    if (!options.sellers.includes(seller)) throw new Error(`${seller} is not an approved seller`);
    const name = sellerName(seller); const chain = authorize(options.policy, seller).chain;
    const employee = body.actAs === 'observer' ? options.observerId : options.employeeId;
    if (!employee) throw new Error('No unassigned employee key is set up. Run bun run company init.');
    const service = options.catalog.get(seller)!;
    const context = { seller, sellerName: name, employee, labels: optionLabels(service) };
    emit({ type: 'turn', question: body.question, seller, sellerName: name, network: networkLabel(chain), actAs: body.actAs, employee });
    if (halted) { emit({ type: 'error', text: `Chat stopped: ${halted}` }); return; }

    const request = withContext(history, body.question);
    const turnPolicy = remainingPolicy(options.policy, reservedMicro, purchases);
    const tracker = new EventTracker(context);
    let harness: Harness;
    try {
      // Identity first, so a refused employee is refused before any payment adapter or model is touched.
      const identity = options.identity(body.actAs, { request, service: service.definition, policy: turnPolicy });
      const transport = await options.transport(chain);
      harness = new Harness({ service, policy: turnPolicy, transport, identity, live: options.live, request,
        ...(options.directory ? { journal: join(options.directory, 'journal.jsonl') } : {}),
        approve: (_text, details) => {
          if (signal?.aborted) return Promise.resolve(false); // The page has gone, so nobody can approve.
          const record = harness.records.find(entry => entry.id === details.recordId);
          if (record) for (const event of tracker.beforeApproval(record)) emit(event);
          emit({ type: 'budget', ...budget(harness) }); // The price is already held while the approval waits.
          const { payee: _payee, ...card } = details; // The page never gets payee addresses.
          return options.bridge.request({ ...card, seller, sellerName: name, what: operationLabel(details.operation), network: networkLabel(details.chain) }, emit);
        },
        // The person picks the provider from live quotes; the usual policy checks and quote then run on the pick.
        choose: details => {
          if (signal?.aborted) return Promise.resolve(undefined);
          const record = harness.records.find(entry => entry.id === details.recordId);
          if (record) for (const event of tracker.beforeChoice(record)) emit(event);
          return options.choices.request(choiceCard(details, context, networkLabel(chain)), emit);
        } });
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      const text = ruleText(error.rule, error.message);
      if (error.rule.startsWith('identity.')) emit({ type: 'identity', ok: false, employee, agent: options.agentId, rule: error.rule, text: `Identity check failed: ${text}`, reason: displayReason(error.message), safr: safrDenial(error.rule) });
      else emit({ type: 'policy', recordId: '', ok: false, rule: error.rule, text: `Refused by policy: ${text}`, reason: displayReason(error.message), safr: safrDenial(error.rule) });
      const row = earlyRefusalRow(context, error.rule, error.message); rows.push(row);
      if (options.directory) appendFileSync(join(options.directory, 'journal.jsonl'), JSON.stringify({ stage: 'refused_before_run', ...row, reason: error.message }) + '\n', { mode: 0o600 });
      emit({ type: 'record', row }); emit({ type: 'budget', ...budget() });
      return;
    }
    current = harness;
    emit({ type: 'identity', ok: true, employee: harness.actor.employeeId, agent: harness.actor.agentId,
      text: `Identity checked: ${harness.actor.employeeId} is assigned to ${harness.actor.agentId}` });

    const flush = () => {
      for (const event of tracker.flush(harness.records)) { if (event.type === 'record') rows.push(event.row); emit(event); }
      emit({ type: 'budget', ...budget(harness) });
    };
    const onAbort = () => { options.bridge.declineAll(); options.choices.cancelAll(); };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const result = await invokeAgent(harness, options.model, { timeoutMs: turnTimeoutMs, onToolResult: flush });
      flush();
      const answer = result.messages.at(-1)?.text ?? '';
      if (!harness.records.length) emit({ type: 'notice', tone: 'ok', text: 'No purchase: the agent answered without buying' });
      emit({ type: 'answer', text: answer });
      history.push({ question: body.question, answer });
    } catch (error) {
      // A turn that ends while an approval waits declines it; let the harness record that before the last flush.
      options.bridge.declineAll(); options.choices.cancelAll(); await new Promise(resolve => setTimeout(resolve, 0));
      flush(); emit({ type: 'error', text: `Stopped: ${displayReason(errorText(error))}` });
    } finally {
      signal?.removeEventListener('abort', onAbort); current = undefined;
      reservedMicro += harness.reservedMicro; purchases += harness.purchaseCount;
      records.push(...harness.records);
      if (options.directory) save(join(options.directory, 'records.json'), records);
      emit({ type: 'budget', ...budget() });
      if (harness.halted) { halted = harness.halted; emit({ type: 'error', text: `Chat stopped: ${harness.halted}` }); }
    }
  }

  // On shutdown: an in-flight payment is marked for reconciliation, as in the terminal chat.
  const cancel = () => { options.bridge.declineAll(); options.choices.cancelAll(); current?.cancel(); };
  return { ask, state, cancel, busy: () => running, get halted() { return halted; } };
}
export type WebChat = ReturnType<typeof createWebChat>;

const loopback = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const refuse = (status: number, error: string) => json(status, { error });
export function tokenMatches(given: string | null, token: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given), b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Server-sent events over the POST response. The page reads them with fetch.
function eventStream(run: (emit: Emit, signal: AbortSignal) => Promise<void>): Response {
  const encoder = new TextEncoder(); const abort = new AbortController();
  let closed = false, heartbeat: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (text: string) => { if (closed) return; try { controller.enqueue(encoder.encode(text)); } catch { closed = true; } };
      const emit: Emit = event => write(`data: ${JSON.stringify(event)}\n\n`);
      heartbeat = setInterval(() => write(': keep-alive\n\n'), 15_000);
      run(emit, abort.signal)
        .catch(error => emit({ type: 'error', text: displayReason(errorText(error)) }))
        .finally(() => { emit({ type: 'done' } satisfies WebEvent); clearInterval(heartbeat); if (!closed) { closed = true; try { controller.close(); } catch { /* already closed */ } } });
    },
    cancel() { closed = true; clearInterval(heartbeat); abort.abort(); },
  });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' } });
}

export interface HandlerOptions { token: string; page: string; nonce: string; port: () => number; chat: Pick<WebChat, 'ask' | 'state' | 'busy'>; bridge: ApprovalBridge; choices: ChoiceBridge; sellers: string[] }
type PeerInfo = { requestIP(request: Request): { address: string } | null };
export function createHandler(options: HandlerOptions) {
  return async (request: Request, server?: PeerInfo): Promise<Response> => {
    // Local only: the socket peer, the Host header (against DNS rebinding) and, for the API, the Origin and page token.
    const peer = server?.requestIP(request)?.address;
    if (server && (!peer || !loopback.has(peer))) return refuse(403, 'This server only accepts connections from this computer');
    const hosts = [`${localHost}:${options.port()}`, `localhost:${options.port()}`];
    if (!hosts.includes(request.headers.get('host') ?? '')) return refuse(403, 'Unexpected Host header');
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/') return new Response(options.page, { headers: {
      'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff',
      // DM Sans and Space Mono come from Google Fonts; the page falls back to system fonts without them.
      'content-security-policy': `default-src 'none'; script-src 'nonce-${options.nonce}'; style-src 'nonce-${options.nonce}' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    } });
    if (!url.pathname.startsWith('/api/')) return refuse(404, 'Not found');
    const origin = request.headers.get('origin');
    if (origin !== null && !hosts.some(host => origin === `http://${host}`)) return refuse(403, 'Cross-origin requests are refused');
    if (!tokenMatches(request.headers.get('x-page-token'), options.token)) return refuse(403, 'Missing or wrong page token');
    const route = `${request.method} ${url.pathname}`;
    if (route === 'GET /api/state') return json(200, options.chat.state());
    if (request.method === 'POST' && !(request.headers.get('content-type') ?? '').startsWith('application/json')) return refuse(415, 'Send JSON');
    const body = request.method === 'POST' ? await request.json().catch(() => undefined) : undefined;
    if (route === 'POST /api/approve') {
      const parsed = approveSchema.safeParse(body);
      if (!parsed.success) return refuse(400, 'Send approvalId and decision (approve or decline)');
      return options.bridge.decide(parsed.data.approvalId, parsed.data.decision === 'approve') ? json(200, { ok: true })
        : refuse(404, 'No approval with that ID is waiting. It may have timed out.');
    }
    if (route === 'POST /api/choose') {
      const parsed = chooseSchema.safeParse(body);
      if (!parsed.success) return refuse(400, 'Send choiceId and value (an offered option, or null to cancel)');
      const decision = options.choices.decide(parsed.data.choiceId, parsed.data.value);
      return decision === 'ok' ? json(200, { ok: true })
        : decision === 'invalid' ? refuse(400, 'That option is not on offer')
        : refuse(404, 'No choice with that ID is waiting. It may have timed out.');
    }
    if (route === 'POST /api/ask') {
      const parsed = askSchema.safeParse(body);
      if (!parsed.success) return refuse(400, 'Send a question, a seller and actAs (employee or observer)');
      if (!options.sellers.includes(parsed.data.seller)) return refuse(400, `${parsed.data.seller} is not an approved seller`);
      if (options.chat.busy()) return refuse(409, 'The agent is still answering the last question');
      return eventStream((emit, signal) => options.chat.ask(parsed.data, emit, signal));
    }
    return refuse(404, 'Not found');
  };
}

async function main() {
  const { values } = args({ payment: { type: 'string' }, live: { type: 'boolean' }, offline: { type: 'boolean' }, company: { type: 'string', default: localCompany },
    employee: { type: 'string' }, observer: { type: 'string' }, 'agent-key': { type: 'string' }, host: { type: 'string', default: localHost }, port: { type: 'string', default: String(defaultPort) } });
  if (values.help) { console.log(`bun run web [--live] [--port ${defaultPort}]\nbun run web:offline   (no keys or wallet: a scripted agent and seller, simulated payments)\nLocal web chat on http://${localHost}:${defaultPort}. Arc sellers from policy.json, with the same policy and identity checks as bun run chat.\nQuote-only is the default. Live mode also requires policy.liveEnabled. Provider choices and approvals above the threshold happen on the page.`); return; }
  if (values.host !== localHost) throw new Error(`The web chat only listens on ${localHost}. Refusing to start on ${values.host}.`);
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be a whole number from 0 to 65535');
  const directory = outputFolder(values.offline ? 'web-offline' : 'web');
  const bridge = new ApprovalBridge(approvalTimeoutMs); const choices = new ChoiceBridge(choiceTimeoutMs);
  let options: Omit<WebChatOptions, 'bridge' | 'choices' | 'directory'>; let mode: string;
  if (values.offline) {
    if (values.live) throw new Error('--offline uses a scripted seller and simulated payments, so it cannot be combined with --live.');
    options = await (await import('../evals/web-offline')).offlineWebChat();
    mode = 'OFFLINE DEMO: scripted agent and seller, simulated payments, no keys or wallet';
  } else {
    const setup = await chatSetup(values);
    const observerFile = values.observer as string || join(setup.companyDirectory, 'observer.json');
    const observerId = existsSync(observerFile) ? credentialSchema.parse(JSON.parse(readFileSync(observerFile, 'utf8'))).id : undefined;
    const sellers = arcSellers(setup.policy, setup.sellers);
    if (!sellers.length) throw new Error('No Arc seller is both approved in policy.json and assigned to the agent. The web chat offers Arc sellers only.');
    options = { policy: setup.policy, live: setup.live, sellers, catalog: setup.catalog, model: setup.model,
      company: companyName(setup.company.companyId), employeeId: setup.employeeId, agentId: setup.agentId, ...(observerId ? { observerId } : {}),
      transport: setup.transport,
      identity: (actAs, binding) => loadIdentity(setup.companyDirectory, actAs === 'observer' ? observerFile : setup.employeeFile, setup.agentFile, binding) };
    mode = `${setup.live ? 'LIVE PAYMENTS' : 'QUOTE ONLY, no payments'} | model ${setup.profile.model}`;
  }
  const chat = createWebChat({ ...options, bridge, choices, directory });
  const token = randomBytes(32).toString('hex'); const nonce = randomBytes(16).toString('base64');
  const page = readFileSync(join(root, 'web', 'index.html'), 'utf8').replaceAll('__PAGE_TOKEN__', token).replaceAll('__NONCE__', nonce);
  let server: ReturnType<typeof Bun.serve> | undefined;
  const handler = createHandler({ token, page, nonce, port: () => server?.port ?? port, chat, bridge, choices, sellers: options.sellers });
  server = Bun.serve({ hostname: localHost, port, idleTimeout: 0, fetch: handler });

  console.log(`\nResearch agent web chat | ${mode}`);
  console.log(`Open http://${localHost}:${server.port} (this computer only). Provider choices and approvals wait ${approvalTimeoutMs / 1000} seconds, then nothing is bought.`);
  console.log(`Sellers: ${options.sellers.map(id => `${id} (${authorize(options.policy, id).chain})`).join(', ')} | Records: ${directory}\nPress Ctrl+C to stop.`);
  const stop = () => { chat.cancel(); server?.stop(true); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
if (import.meta.main) main().catch(error => { console.error(errorText(error)); process.exitCode = 1; });
