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

// Interactive terminal chat over the same agent, harness and policy as src/main.ts. Each question is signed
// and checked as its own identity session. Setup is shared with the web chat in src/setup.ts.
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { authorize } from './policy';
import { Harness, logRefusalBeforeRun } from './harness';
import { args, outputFolder, save } from './cli';
import { invokeAgent } from './agent';
import { completionText } from './web-events';
import { errorText, micro, Refusal, type RecordEntry } from './types';
import { loadIdentity, localCompany } from './company';
import { chatSetup, remainingPolicy, withContext, type Turn } from './setup';

const usdc = (microAmount: number) => String(microAmount / 1e6);

async function main() {
  const { values } = args({ payment: { type: 'string' }, live: { type: 'boolean' },
    company: { type: 'string', default: localCompany }, employee: { type: 'string' }, 'agent-key': { type: 'string' } });
  if (values.help) { console.log('bun run chat [--service ID] [--live]\nAsk research questions in a loop. Sellers come from policy.json and the company registry.\nSwitch seller with /seller ID. Quote-only is the default. Live mode also requires policy.liveEnabled. Type exit to finish.'); return; }
  const { companyDirectory, employeeFile, agentFile, employeeId, agentId, policy, live, sellers, catalog, profile, model, transport: transportFor } = await chatSetup(values);
  const requested = values.service as string | undefined;
  const listSellers = () => sellers.forEach((id, index) => console.log(`  ${index + 1}. ${id}: ${catalog.get(id)!.definition.name} (${authorize(policy, id).chain})`));
  const activate = async (id: string) => {
    const chain = authorize(policy, id).chain;
    const transport = await transportFor(chain);
    console.log(`  Seller: ${catalog.get(id)!.definition.name} (${id}) on ${chain}`);
    return { service: catalog.get(id)!, transport };
  };
  const directory = outputFolder('chat');

  console.log(`\nResearch agent | ${live ? 'LIVE PAYMENTS' : 'QUOTE ONLY, no payments'} | model ${profile.model}`);
  console.log(`Employee ${employeeId} using ${agentId}. Every question is signed and checked against the company registry.`);
  console.log(`Chat budget: ${policy.limits.sessionUsdc} USDC and ${policy.limits.maxPurchases} purchases across sellers. Approval needed above ${policy.limits.approvalAboveUsdc} USDC.`);
  console.log('Approved sellers (policy.json and company registry):'); listSellers();

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let current: Harness | undefined;
  rl.on('SIGINT', () => { current?.cancel(); rl.close(); });
  const history: Turn[] = []; const records: RecordEntry[] = [];
  let reservedMicro = 0, purchases = 0;
  try {
    let choice = requested ?? sellers[0]!;
    if (!requested && sellers.length > 1) {
      const answer = (await rl.question(`Choose a seller [1-${sellers.length}, default 1]: `)).trim();
      const picked = sellers[Number(answer || '1') - 1] ?? (sellers.includes(answer) ? answer : undefined);
      if (!picked) console.log('  Not on the list; using the first approved seller.');
      choice = picked ?? sellers[0]!;
    }
    let active = await activate(choice);
    console.log(`Records: ${directory}\nAsk a research question. Switch seller with /seller ID, list with /seller, or type exit.`);
    while (true) {
      let question: string;
      try { question = (await rl.question('\nyou> ')).trim(); } catch { break; }
      if (!question) continue;
      if (/^(exit|quit)$/i.test(question)) break;
      if (/^\/sellers?\b/i.test(question)) {
        const id = question.split(/\s+/)[1];
        if (!id) { listSellers(); continue; }
        if (!sellers.includes(id)) { console.log(`  ${id} is not approved for ${agentId}. Approved: ${sellers.join(', ')}`); continue; }
        try { active = await activate(id); } catch (error) { console.log(`  Could not switch: ${errorText(error)}`); }
        continue;
      }
      const { service, transport } = active;
      const request = withContext(history, question);
      const turnPolicy = remainingPolicy(policy, reservedMicro, purchases);
      let harness: Harness;
      try {
        const identity = loadIdentity(companyDirectory, employeeFile, agentFile, { request, service: service.definition, policy: turnPolicy });
        harness = new Harness({ service, policy: turnPolicy, transport, identity, live, request, journal: join(directory, 'journal.jsonl'),
          approve: async text => /^y(es)?$/i.test((await rl.question(`\n  APPROVAL NEEDED\n  ${text.replace(/\n/g, '\n  ')}\n  Approve? [y/N] `)).trim()) });
      } catch (error) {
        if (error instanceof Refusal) logRefusalBeforeRun(join(directory, 'journal.jsonl'), error.rule, error.message);
        console.log(`  Refused before the model ran: ${errorText(error)}`); continue;
      }
      current = harness;
      console.log(`  Identity checked: ${harness.actor.employeeId} -> ${harness.actor.agentId} | seller ${service.definition.id} | session ${harness.actor.sessionId.slice(0, 8)}`);
      const printed = new Set<string>();
      try {
        const result = await invokeAgent(harness, model, { onToolResult: () => {
          for (const record of harness.records) if (record.outcome && !printed.has(record.id)) {
            printed.add(record.id);
            console.log(`  ${record.operation}: ${record.outcome}${record.quote ? ` | ${record.quote.priceUsdc} USDC` : ''}${record.reason ? ` | ${record.reason}` : ''}`);
            const text = ['paid', 'simulated'].includes(record.outcome!) ? completionText(record.payment?.output) : undefined;
            if (text) console.log(`\n${text}\n`);
          }
        } });
        const answer = result.messages.at(-1)?.text ?? '';
        console.log(`\nagent> ${answer}`);
        history.push({ question, answer });
      } catch (error) { console.log(`  Stopped: ${errorText(error)}`); }
      finally {
        current = undefined;
        reservedMicro += harness.reservedMicro; purchases += harness.purchaseCount;
        records.push(...harness.records); save(join(directory, 'records.json'), records);
        for (const record of harness.records) if (record.payment?.tx) console.log(`  Receipt (${record.operation}): ${record.payment.tx}`);
        const left = Math.max(0, micro(policy.limits.sessionUsdc) - reservedMicro);
        console.log(`  Budget ${live ? 'used' : 'reserved in rehearsal'}: ${usdc(reservedMicro)} of ${policy.limits.sessionUsdc} USDC (${usdc(left)} left), ${purchases} of ${policy.limits.maxPurchases} purchases`);
      }
      // An uncertain payment halts the harness. Later questions would get a fresh harness, so stop the chat here.
      if (harness.halted) { console.log(`\n  Chat stopped: ${harness.halted}`); break; }
    }
  } finally {
    rl.close();
    const refusals = records.filter(record => ['denied', 'approval_denied'].includes(record.outcome ?? '')).length;
    console.log(`\nChat ended. Paid: ${records.filter(record => record.outcome === 'paid').length} | Refusals: ${refusals} | Records: ${directory}`);
  }
}
if (import.meta.main) main().catch(error => { console.error(errorText(error)); process.exitCode = 1; });
