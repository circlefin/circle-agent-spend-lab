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

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { loadService } from './service';
import { authorize } from './policy';
import { Harness, logRefusalBeforeRun } from './harness';
import { loadPayment } from './payment';
import { args, readPolicy, outputFolder, save } from './cli';
import { invokeAgent, makeModel, modelProfileSchema } from './agent';
import { errorText, Refusal } from './types';
import { completionText } from './web-events';
import { loadIdentity, localCompany } from './company';

async function main() {
  const { values } = args({ payment: { type: 'string' }, live: { type: 'boolean' }, prompt: { type: 'string' }, 'prompt-file': { type: 'string' },
    company: { type: 'string', default: localCompany }, employee: { type: 'string' }, 'agent-key': { type: 'string' } });
  if (values.help) { console.log('bun run agent --service SERVICE --payment ADAPTER --prompt-file FILE [--live]\nFirst: bun run company init\nIdentity defaults to .local/. Overrides: --company DIRECTORY --employee KEY_FILE --agent-key KEY_FILE\nQuote-only is the default. Live mode also requires policy.liveEnabled. Funding/login are separate.'); return; }
  if (!values.service) throw new Error('--service is required');
  if (!values.payment) throw new Error('--payment is required. Select a local adapter from payments/.');
  const service = await loadService(values.service as string);
  const policy = readPolicy(values.policy as string); const authority = authorize(policy, service.definition.id);
  // Fail fast before the Circle CLI session check; the harness repeats both checks.
  for (const id of Object.keys(authority.operations)) if (!service.definition.operations[id]) throw new Error(`Policy authorizes unknown operation ${id}`);
  if (values.live && !policy.liveEnabled) throw new Error('policy.liveEnabled is false');
  if (values.prompt && values['prompt-file']) throw new Error('Choose --prompt or --prompt-file');
  const request = values.prompt as string || (values['prompt-file'] ? readFileSync(values['prompt-file'] as string, 'utf8') : '');
  if (!request.trim()) throw new Error('Supply --prompt or --prompt-file');
  const companyDirectory = values.company as string;
  const directory = outputFolder('agent');
  let identity: ReturnType<typeof loadIdentity>;
  try { identity = loadIdentity(companyDirectory, values.employee as string || join(companyDirectory, 'employee.json'), values['agent-key'] as string || join(companyDirectory, 'agent.json'), { request, service: service.definition, policy }); }
  catch (error) { if (error instanceof Refusal) logRefusalBeforeRun(join(directory, 'journal.jsonl'), error.rule, error.message); throw error; }
  const profile = modelProfileSchema.parse({ name: 'terminal', model: process.env.OPENAI_MODEL, apiMode: process.env.OPENAI_API_MODE ?? 'responses', apiKeyEnv: 'OPENAI_API_KEY', ...(process.env.OPENAI_BASE_URL ? { baseUrlEnv: 'OPENAI_BASE_URL' } : {}) });
  const model = makeModel(profile);
  const transport = await loadPayment(values.payment as string, { chain: authority.chain, live: Boolean(values.live) });
  const rl = process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
  const harness = new Harness({ service, policy, transport, identity, live: Boolean(values.live), request, journal: join(directory, 'journal.jsonl'),
    approve: async text => rl ? /^y(es)?$/i.test((await rl.question(text + ' [y/N] ')).trim()) : false });
  console.log(`${service.definition.name} | payment ${values.payment} | ${values.live ? 'LIVE PAYMENT' : 'QUOTE ONLY'} | model ${profile.model}\nRecords: ${directory}`);
  console.log(`Authority: ${harness.actor.companyId} / ${harness.actor.employeeId} -> ${harness.actor.agentId}`);
  const events: unknown[] = []; const printed = new Set<string>(); const started = performance.now();
  try {
    const result = await invokeAgent(harness, model, { events, onToolResult: () => {
      for (const record of harness.records) if (record.outcome && !printed.has(record.id)) {
        printed.add(record.id);
        console.log(`${record.operation}: ${record.outcome}${record.quote ? ` | quote ${record.quote.priceUsdc} USDC` : ''}${record.reason ? ` | ${record.reason}` : ''}`);
        const text = ['paid', 'simulated'].includes(record.outcome!) ? completionText(record.payment?.output) : undefined;
        if (text) console.log(`\n${text}\n`);
      }
    } });
    console.log(result.messages.at(-1)?.text);
    save(join(directory, 'trace.json'), result.messages.map(message => message.toDict()));
  } finally {
    rl?.close(); save(join(directory, 'events.json'), events); save(join(directory, 'records.json'), harness.records);
    const records = harness.records;
    const paid = records.filter(record => record.outcome === 'paid');
    const knownTotal = paid.reduce((total, record) => total + (record.payment?.amountUsdc ?? 0), 0);
    const unknown = records.filter(record => record.outcome === 'unknown_reconcile').length;
    const missingAmounts = paid.filter(record => record.payment?.amountUsdc === undefined).length;
    console.log(`\nPayments: ${paid.length} | Refusals: ${records.filter(record => ['denied', 'approval_denied'].includes(record.outcome ?? '')).length} | Approvals yes/no: ${records.filter(record => record.approved === true).length}/${records.filter(record => record.approved === false).length}`);
    console.log(`Reported payment total: ${knownTotal.toFixed(6)} USDC${missingAmounts ? ` + ${missingAmounts} unreported amount(s)` : ''} | Reserved: ${(harness.reservedMicro / 1e6).toFixed(6)} USDC | Uncertain: ${unknown} | Elapsed: ${((performance.now() - started) / 1000).toFixed(2)}s`);
    for (const record of paid) if (record.payment?.tx) console.log(`Receipt (${record.operation}): ${record.payment.tx}`);
  }
}
if (import.meta.main) main().catch(error => { console.error(errorText(error)); process.exitCode = 1; });
