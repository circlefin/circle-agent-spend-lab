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

// What the local web chat (src/web.ts) streams to the page: the approval bridge and a plain-English
// mapping from harness records. No server code here, so tests drive it directly.
import { randomUUID } from 'node:crypto';
import type { ApprovalDetails, ChoiceDetails } from './harness';
import type { Policy } from './policy';
import type { Service } from './service';
import { safrDenial, type SafrDecision } from './safr';
import { micro, type RecordEntry } from './types';

export type Tone = 'ok' | 'refused' | 'rehearsal' | 'warn';
export interface RecordRow {
  id: string; at: string; employee: string; seller: string; sellerName: string; operation: string; what: string; purpose: string;
  priceUsdc?: number; chain?: string; network?: string; outcome: string; outcomeText: string; pill: string; tone: Tone;
  rule?: string; receiptUrl?: string; chosen?: string; decided?: string; safr?: SafrDecision;
}
export interface Budget { sessionUsdc: number; spentUsdc: number; reservedUsdc: number; leftUsdc: number; purchases: number; maxPurchases: number }
// No payee address: the page never shows wallet or payee addresses.
export interface ApprovalCard extends Omit<ApprovalDetails, 'payee'> { seller: string; sellerName: string; what: string; network: string }
export type ApprovalBy = 'user' | 'timeout' | 'closed';
export type PaymentStatus = 'paid' | 'simulated' | 'quote_only' | 'declined' | 'not_chosen' | 'failed' | 'uncertain';
// Display names for choice values, from the service metadata, for example { provider: 'Anthropic', label: 'Claude Sonnet 5.5' }.
export type OptionLabels = Record<string, { provider: string; label: string }>;
export interface ProviderOption { value: string; provider: string; label: string; priceUsdc?: number; network: string; available: boolean; reason?: string }
export interface ChoiceCard { recordId: string; operation: string; what: string; purpose: string; seller: string; sellerName: string; network: string; options: ProviderOption[] }
export type ChoiceBy = ApprovalBy | 'unavailable';
export interface BoughtAnswer { text: string; label: string; provider: string }

export type WebEvent =
  | { type: 'turn'; question: string; seller: string; sellerName: string; network: string; actAs: 'employee' | 'observer'; employee: string }
  | { type: 'identity'; ok: true; employee: string; agent: string; text: string }
  | { type: 'identity'; ok: false; employee: string; agent: string; rule: string; text: string; reason: string; safr: SafrDecision }
  | { type: 'proposal'; recordId: string; action: string; seller: string; sellerName: string; operation: string; what: string; purpose: string; text: string }
  | { type: 'policy'; recordId: string; ok: boolean; rule?: string; text: string; reason?: string; safr?: SafrDecision }
  | { type: 'quote'; recordId: string; priceUsdc: number; chain: string; network: string; text: string }
  | ({ type: 'approval_requested'; approvalId: string; expiresAt: number; timeoutSeconds: number } & ApprovalCard)
  | { type: 'approval_result'; approvalId: string; recordId: string; approved: boolean; by: ApprovalBy; text: string }
  | ({ type: 'provider_choice_requested'; choiceId: string; expiresAt: number; timeoutSeconds: number } & ChoiceCard)
  | { type: 'provider_choice_result'; choiceId: string; recordId: string; value?: string; label?: string; provider?: string; by: ChoiceBy; text: string }
  | { type: 'payment'; recordId: string; status: PaymentStatus; tone: Tone; amountUsdc?: number; chain?: string; network?: string; receiptUrl?: string; text: string; answer?: BoughtAnswer; safr?: SafrDecision }
  | { type: 'notice'; recordId?: string; tone: Tone; text: string }
  | { type: 'record'; row: RecordRow }
  | { type: 'answer'; text: string }
  | ({ type: 'budget' } & Budget)
  | { type: 'error'; text: string }
  | { type: 'done' };
export type Emit = (event: WebEvent) => void;

// Networks the page can name and link. Arc mainnet is chain ID 5042. Explorers: explorer.arc.io (mainnet) and explorer.testnet.arc.io (testnet),
// per https://docs.arc.io/arc/references/connect-to-arc and https://docs.arc.io/integrate/infrastructure.
const networks: Record<string, { label: string; tx?: string }> = {
  ARC: { label: 'Arc', tx: 'https://explorer.arc.io/tx/' },
  'ARC-TESTNET': { label: 'Arc Testnet', tx: 'https://explorer.testnet.arc.io/tx/' },
};
export const networkLabel = (chain: string): string => networks[chain]?.label ?? chain;
export function receiptUrl(chain: string, tx: string | undefined): string | undefined {
  const base = networks[chain]?.tx;
  return base && tx && /^0x[0-9a-fA-F]{64}$/.test(tx) ? base + tx : undefined;
}

// Plain words for operations the bundled sellers offer. Unknown operations fall back to their ID.
const operationWords: Record<string, string> = { chat_completion: 'a model answer' };
export const operationLabel = (operation: string): string => operationWords[operation] ?? operation.replace(/_/g, ' ');

// Plain words for every rule the harness, policy, identity checks and bundled adapters can name.
const ruleWords: Record<string, string> = {
  'identity.assignment': 'This employee is not assigned to the research agent',
  'identity.employee': 'This employee is not active in the company registry',
  'identity.agent': 'The research agent is not active in the company registry',
  'identity.service': 'The research agent is not assigned to this seller',
  'identity.proof': 'The signatures do not match the company registry',
  'identity.expired': 'The signed request expired. Ask again to sign a new one',
  'identity.context': 'The request changed after the employee signed it',
  'identity.replay': 'This signed request was already used',
  'identity.company': 'The signed request belongs to another company',
  'identity.registry': 'The company registry could not be read',
  service: 'This seller is not approved in the company policy',
  operation: 'This operation is not on the approved list',
  input: 'The request did not match the approved format for this purchase',
  origin: 'The request pointed away from the approved seller',
  price: 'The price is above the company cap for this purchase',
  budget: 'This purchase would go over the chat budget',
  count: 'The purchase limit for this chat has been reached',
  network: 'The seller asked to be paid on a network the policy does not allow',
  payee: "The seller's payment address is not on the approved list",
  purpose: 'A purchase needs a stated purpose',
  approval: 'The approver declined',
  choice: 'No provider was chosen, so nothing was bought',
  'choice.scope': 'The company policy lists no options to choose from',
  model: 'This model is not on the approved list',
  'model.scope': 'The company policy approves no models for this seller',
  reconcile: 'An earlier payment needs checking before any more purchases',
  closed: 'The turn had already ended',
  live: 'Live payments are switched off in the company policy',
};
// Adapter errors can echo the command line, wallet address included. The page shows only the cause, with addresses and hashes hidden.
export function displayReason(text: string): string {
  const masked = text.replace(/^circle\s[\s\S]*?\sfailed:\s*/, '').replace(/^(?:Error:\s*)+/, '').trim()
    .replace(/0x[0-9a-fA-F]{64}/g, '[transaction hidden]').replace(/0x[0-9a-fA-F]{40}/g, '[address hidden]');
  return masked.length > 240 ? `${masked.slice(0, 237)}...` : masked;
}
export const ruleText = (rule: string | undefined, reason = ''): string => (rule && ruleWords[rule]) || displayReason(reason) || 'Refused';
const isIdentityRule = (rule: string | undefined) => Boolean(rule?.startsWith('identity.'));

const usdcText = (amount: number) => `${amount} USDC`;
const paymentTone: Record<PaymentStatus, Tone> = { paid: 'ok', simulated: 'ok', quote_only: 'rehearsal', declined: 'refused', not_chosen: 'warn', failed: 'warn', uncertain: 'warn' };
// The short outcome label on each record row.
const outcomePills: Record<string, string> = { paid: 'Paid', simulated: 'Simulated', quote_only: 'Quoted', denied: 'Refused', quoted: 'Price checked', unknown_reconcile: 'Check wallet', failed: 'Not completed' };
const paymentStatus = (record: RecordEntry): PaymentStatus | undefined => {
  switch (record.outcome) {
    case 'paid': return 'paid';
    case 'simulated': return 'simulated';
    case 'quote_only': return 'quote_only';
    case 'approval_denied': return record.rule === 'choice' ? 'not_chosen' : 'declined';
    case 'unknown_reconcile': return 'uncertain';
    case 'failed': return record.paymentId ? 'failed' : undefined;
    default: return undefined;
  }
};

// Display names for a seller's choice options, from operation metadata such as { "models": { "anthropic/...": { "provider", "label" } } }.
export function optionLabels(service: Service): OptionLabels {
  const labels: OptionLabels = {};
  for (const operation of Object.values(service.definition.operations)) {
    const models = operation.metadata?.models;
    if (!models || typeof models !== 'object') continue;
    for (const [value, names] of Object.entries(models as Record<string, { provider?: unknown; label?: unknown }>))
      if (typeof names?.provider === 'string' && typeof names.label === 'string') labels[value] = { provider: names.provider, label: names.label };
  }
  return labels;
}
export interface MapContext { seller: string; sellerName: string; employee: string; labels?: OptionLabels }
const chosenText = (record: RecordEntry, context: MapContext): string | undefined => {
  if (!record.chosen) return undefined;
  const option = context.labels?.[record.chosen];
  return option ? `${option.label} (${option.provider})` : record.chosen;
};
// The text of an OpenAI-compatible chat completion, when the purchase returned one.
export function completionText(output: unknown): string | undefined {
  const content = (output as { choices?: Array<{ message?: { content?: unknown } }> } | null)?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) return undefined;
  const text = content.trim();
  return text.length > 4000 ? `${text.slice(0, 3997)}...` : text;
}

export function proposalEvent(record: RecordEntry, context: MapContext): WebEvent {
  const what = operationLabel(record.operation);
  const text = record.action === 'buy' ? `Wants to buy ${what} from ${context.sellerName}` : `Asked ${context.sellerName} for a price on ${what}`;
  return { type: 'proposal', recordId: record.id, action: record.action, seller: context.seller, sellerName: context.sellerName, operation: record.operation, what, purpose: record.purpose ?? '', text };
}
export function quoteEvent(record: RecordEntry): WebEvent | undefined {
  if (!record.quote) return undefined;
  const network = networkLabel(record.quote.chain);
  return { type: 'quote', recordId: record.id, priceUsdc: record.quote.priceUsdc, chain: record.quote.chain, network, text: `Price: ${usdcText(record.quote.priceUsdc)} on ${network}` };
}
export function paymentEvent(record: RecordEntry, context?: MapContext): WebEvent | undefined {
  const status = paymentStatus(record);
  if (!status) return undefined;
  const chain = record.quote?.chain; const network = chain ? networkLabel(chain) : undefined;
  const amount = record.payment?.amountUsdc ?? record.quote?.priceUsdc;
  const tx = record.payment?.tx; const url = chain ? receiptUrl(chain, tx) : undefined;
  const text = {
    paid: `Paid ${amount === undefined ? 'an unreported amount' : usdcText(amount)}${network ? ` on ${network}` : ''}`,
    simulated: `Simulated payment of ${amount === undefined ? 'an unreported amount' : usdcText(amount)}`,
    quote_only: 'Quoted, not paid',
    declined: 'No payment: the approver declined',
    not_chosen: 'Nothing bought: no provider was chosen',
    failed: `Payment did not go through: ${displayReason(record.reason ?? '') || 'the payment adapter refused it before paying'}`,
    uncertain: 'Payment outcome unknown. Check the wallet before any more purchases',
  }[status];
  const bought = ['paid', 'simulated'].includes(status) ? completionText(record.payment?.output) : undefined;
  const option = record.chosen ? context?.labels?.[record.chosen] : undefined;
  return { type: 'payment', recordId: record.id, status, tone: paymentTone[status], ...(amount !== undefined && ['paid', 'simulated'].includes(status) ? { amountUsdc: amount } : {}),
    ...(chain ? { chain, network } : {}), ...(url ? { receiptUrl: url } : {}), text,
    ...(bought ? { answer: { text: bought, label: option?.label ?? record.chosen ?? 'The model', provider: option?.provider ?? context?.sellerName ?? '' } } : {}),
    ...(record.safr ? { safr: record.safr } : {}) };
}
export function recordRow(record: RecordEntry, context: MapContext): RecordRow {
  const chain = record.quote?.chain;
  const status = paymentStatus(record);
  const refused = record.outcome === 'denied';
  const [outcomeText, tone]: [string, Tone] =
    refused ? [`Refused: ${ruleText(record.rule, record.reason)}`, 'refused']
    : status === 'paid' ? ['Paid', 'ok']
    : status === 'simulated' ? ['Simulated payment', 'ok']
    : status === 'quote_only' ? ['Quoted, not paid', 'rehearsal']
    : status === 'declined' ? ['Declined by the approver', 'refused']
    : status === 'not_chosen' ? ['No provider chosen, nothing bought', 'warn']
    : status === 'uncertain' ? ['Payment outcome unknown', 'warn']
    : status === 'failed' ? ['Payment did not go through', 'warn']
    : record.outcome === 'quoted' ? ['Price checked, no purchase', 'ok']
    : ['Seller error, no purchase', 'warn'];
  const url = chain ? receiptUrl(chain, record.payment?.tx) : undefined;
  const chosen = chosenText(record, context);
  const outcome = record.outcome ?? 'failed';
  const pill = status === 'not_chosen' ? 'Not bought' : status === 'declined' ? 'Declined' : outcomePills[outcome] ?? outcome;
  const decided = record.approved ? 'Approved on this screen' : record.chosen ? 'Provider chosen on this screen' : undefined;
  return { id: record.id, at: record.at, employee: record.identity?.employeeId ?? context.employee, seller: context.seller, sellerName: context.sellerName,
    operation: record.operation, what: operationLabel(record.operation), purpose: record.purpose ?? '',
    ...(record.quote ? { priceUsdc: record.quote.priceUsdc } : {}), ...(chain ? { chain, network: networkLabel(chain) } : {}),
    outcome, outcomeText, pill, tone, ...(record.rule && (refused || status === 'declined' || status === 'not_chosen') ? { rule: record.rule } : {}),
    ...(url ? { receiptUrl: url } : {}), ...(chosen ? { chosen } : {}), ...(decided ? { decided } : {}), ...(record.safr ? { safr: record.safr } : {}) };
}
// A refusal before the model runs, such as an unassigned employee or live payments switched off, is still a decision on the record.
export function earlyRefusalRow(context: MapContext, rule: string, reason: string, at = new Date().toISOString()): RecordRow {
  return { id: randomUUID(), at, employee: context.employee, seller: context.seller, sellerName: context.sellerName, operation: '', what: 'nothing requested',
    purpose: '', outcome: 'denied', outcomeText: `Refused before the agent ran: ${ruleText(rule, reason)}`, pill: outcomePills.denied!, tone: 'refused', rule, safr: safrDenial(rule) };
}

// Turns harness records into page events, showing each stage of each record once.
export class EventTracker {
  private shown = new Map<string, Set<string>>();
  constructor(readonly context: MapContext) {}
  private first(id: string, stage: string): boolean {
    let stages = this.shown.get(id);
    if (!stages) this.shown.set(id, stages = new Set());
    if (stages.has(stage)) return false;
    stages.add(stage); return true;
  }
  // Called while a person chooses the provider: only the proposal so far. Policy and the quote follow the pick.
  beforeChoice(record: RecordEntry): WebEvent[] {
    return this.first(record.id, 'proposal') ? [proposalEvent(record, this.context)] : [];
  }
  // Called while a purchase waits for approval: the proposal, the passed policy check and the quote.
  beforeApproval(record: RecordEntry): WebEvent[] {
    const events: WebEvent[] = [];
    if (this.first(record.id, 'proposal')) events.push(proposalEvent(record, this.context));
    if (this.first(record.id, 'policy')) events.push({ type: 'policy', recordId: record.id, ok: true, text: 'Allowed by policy' });
    const quote = quoteEvent(record);
    if (quote && this.first(record.id, 'quote')) events.push(quote);
    return events;
  }
  // Called after each tool result and at the end of a turn. Records still in progress wait.
  flush(records: RecordEntry[]): WebEvent[] {
    const events: WebEvent[] = [];
    for (const record of records) if (record.outcome) events.push(...this.finished(record));
    return events;
  }
  private finished(record: RecordEntry): WebEvent[] {
    const events: WebEvent[] = []; const id = record.id;
    if (this.first(id, 'proposal')) events.push(proposalEvent(record, this.context));
    const refused = record.outcome === 'denied';
    if (this.first(id, 'policy')) {
      if (refused && isIdentityRule(record.rule)) events.push({ type: 'identity', ok: false, employee: record.identity?.employeeId ?? this.context.employee, agent: record.identity?.agentId ?? '', rule: record.rule!, text: `Identity check failed: ${ruleText(record.rule, record.reason)}`, reason: displayReason(record.reason ?? ''), safr: safrDenial(record.rule) });
      else if (refused) events.push({ type: 'policy', recordId: id, ok: false, rule: record.rule, text: `Refused by policy: ${ruleText(record.rule, record.reason)}`, reason: displayReason(record.reason ?? ''), safr: safrDenial(record.rule) });
      else if (record.rule === 'choice') { /* Nothing was chosen, so no policy check ran on a purchase. */ }
      else if (record.outcome === 'failed' && !record.paymentId) events.push({ type: 'notice', recordId: id, tone: 'warn', text: `${this.context.sellerName} could not complete this step: ${displayReason(record.reason ?? '') || 'unknown error'}` });
      else events.push({ type: 'policy', recordId: id, ok: true, text: 'Allowed by policy' });
    }
    const quote = quoteEvent(record);
    if (quote && this.first(id, 'quote')) events.push(quote);
    const payment = paymentEvent(record, this.context);
    if (payment && this.first(id, 'payment')) events.push(payment);
    if (this.first(id, 'record')) events.push({ type: 'record', row: recordRow(record, this.context) });
    return events;
  }
}

// Spent is what was paid; reserved is the rest of what is held (quote-only rehearsals, unknown outcomes, a reservation above the amount paid).
export function budgetOf(policy: Policy, reservedMicro: number, purchases: number, records: RecordEntry[]): Budget {
  const paid = records.filter(record => record.outcome === 'paid' || record.outcome === 'simulated');
  const spentMicro = paid.reduce((sum, record) => sum + micro(record.payment?.amountUsdc ?? record.quote?.priceUsdc ?? 0), 0);
  const sessionMicro = micro(policy.limits.sessionUsdc);
  return { sessionUsdc: sessionMicro / 1e6, spentUsdc: spentMicro / 1e6, reservedUsdc: Math.max(0, reservedMicro - spentMicro) / 1e6,
    leftUsdc: Math.max(0, sessionMicro - reservedMicro) / 1e6, purchases, maxPurchases: policy.limits.maxPurchases };
}

// Bridges the harness approval callback to the page. No answer within the timeout counts as declined.
export class ApprovalBridge {
  private pending = new Map<string, (approved: boolean, by: ApprovalBy) => void>();
  constructor(readonly timeoutMs = 120_000) {}
  get waiting(): number { return this.pending.size; }
  request(card: ApprovalCard, emit: Emit): Promise<boolean> {
    const approvalId = randomUUID();
    return new Promise<boolean>(resolve => {
      const finish = (approved: boolean, by: ApprovalBy) => {
        if (!this.pending.delete(approvalId)) return;
        clearTimeout(timer);
        const text = approved ? 'Approved' : by === 'timeout' ? `No answer within ${Math.round(this.timeoutMs / 1000)} seconds, so it was declined`
          : by === 'closed' ? 'The page closed, so it was declined' : 'Declined';
        try { emit({ type: 'approval_result', approvalId, recordId: card.recordId, approved, by, text }); } finally { resolve(approved); }
      };
      const timer = setTimeout(() => finish(false, 'timeout'), this.timeoutMs);
      this.pending.set(approvalId, finish);
      try { emit({ type: 'approval_requested', approvalId, ...card, expiresAt: Date.now() + this.timeoutMs, timeoutSeconds: Math.round(this.timeoutMs / 1000) }); }
      catch { finish(false, 'closed'); }
    });
  }
  // Returns false when no approval with that ID is waiting (already decided, timed out or unknown).
  decide(approvalId: string, approved: boolean): boolean {
    const finish = this.pending.get(approvalId);
    if (!finish) return false;
    finish(approved, 'user'); return true;
  }
  declineAll(): void { for (const finish of [...this.pending.values()]) finish(false, 'closed'); }
}

// Builds the provider cards from the harness choice: names from the service metadata, live quotes, and why an option is unavailable.
export function choiceCard(details: ChoiceDetails, context: MapContext, network: string): ChoiceCard {
  return { recordId: details.recordId, operation: details.operation, what: operationLabel(details.operation), purpose: details.purpose,
    seller: context.seller, sellerName: context.sellerName, network,
    options: details.options.map(option => {
      const names = context.labels?.[option.value] ?? { provider: option.value.split('/')[0] ?? option.value, label: option.value };
      return { value: option.value, ...names, network, available: Boolean(option.quote && !option.refused),
        ...(option.quote ? { priceUsdc: option.quote.priceUsdc } : {}), ...(option.refused ? { reason: ruleText(option.refused.rule, option.refused.reason) } : {}) };
    }) };
}

// Bridges the harness choose callback to the page: the person picks one provider card. No pick within the timeout buys nothing.
export type ChoiceDecision = 'ok' | 'unknown' | 'invalid';
export class ChoiceBridge {
  private pending = new Map<string, { finish: (value: string | undefined, by: ChoiceBy) => void; values: Set<string> }>();
  constructor(readonly timeoutMs = 120_000) {}
  get waiting(): number { return this.pending.size; }
  request(card: ChoiceCard, emit: Emit): Promise<string | undefined> {
    const choiceId = randomUUID();
    const values = new Set(card.options.filter(option => option.available).map(option => option.value));
    return new Promise<string | undefined>(resolve => {
      const finish = (value: string | undefined, by: ChoiceBy) => {
        if (!this.pending.delete(choiceId)) return;
        clearTimeout(timer);
        const option = card.options.find(entry => entry.value === value);
        const text = option ? `Chose ${option.label} from ${option.provider}`
          : by === 'timeout' ? `No provider chosen within ${Math.round(this.timeoutMs / 1000)} seconds, so nothing was bought`
          : by === 'unavailable' ? 'No provider can take this request right now, so nothing was bought'
          : by === 'closed' ? 'The page closed, so nothing was bought' : 'Cancelled, so nothing was bought';
        try { emit({ type: 'provider_choice_result', choiceId, recordId: card.recordId, ...(option ? { value: option.value, label: option.label, provider: option.provider } : {}), by, text }); }
        finally { resolve(option?.value); }
      };
      const timer = setTimeout(() => finish(undefined, 'timeout'), this.timeoutMs);
      this.pending.set(choiceId, { finish, values });
      try { emit({ type: 'provider_choice_requested', choiceId, ...card, expiresAt: Date.now() + this.timeoutMs, timeoutSeconds: Math.round(this.timeoutMs / 1000) }); }
      catch { finish(undefined, 'closed'); return; }
      if (!values.size) finish(undefined, 'unavailable');
    });
  }
  // value null cancels. 'unknown': no choice with that ID is waiting. 'invalid': that option is not on offer.
  decide(choiceId: string, value: string | null): ChoiceDecision {
    const entry = this.pending.get(choiceId);
    if (!entry) return 'unknown';
    if (value !== null && !entry.values.has(value)) return 'invalid';
    entry.finish(value ?? undefined, 'user'); return 'ok';
  }
  cancelAll(): void { for (const entry of [...this.pending.values()]) entry.finish(undefined, 'closed'); }
}
