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

import { args, readPolicy } from '../src/cli';
import { Harness, type ChoiceDetails } from '../src/harness';
import { exampleCompany, IdentitySession, newCredential, signSession } from '../src/identity';
import { loadService } from '../src/service';
import { Refusal, errorText } from '../src/types';
import { finalSchema, invokeAgent } from '../src/agent';
import { completionText, networkLabel, optionLabels } from '../src/web-events';
import { caseRequest, scriptedModel } from './cases';
import { caseCall, choiceField, FundedFixtureTransport, offlinePolicyPath, type Scenario } from './fixtures';
import { score } from './score';

export const demoCases = ['answer', 'unassigned', 'unknown-agent', 'wrong-key', 'revoked', 'scope', 'unsupported', 'approval', 'uncertain'] as const;
export type DemoCase = typeof demoCases[number];
const identityRules: Partial<Record<DemoCase, string>> = {
  unassigned: 'identity.assignment', 'unknown-agent': 'identity.agent', 'wrong-key': 'identity.proof', revoked: 'identity.agent',
};
const descriptions: Record<DemoCase, string> = {
  answer: 'Assigned employee asks a research question and the answer is bought',
  unassigned: 'Registered employee is not assigned to the agent',
  'unknown-agent': 'Agent is absent from the company allowlist',
  'wrong-key': 'Caller copies an approved agent ID but uses another key',
  revoked: 'Company has revoked the agent',
  scope: 'The agent asks for a model or operation the company has not approved',
  unsupported: 'Question needs live market data, which the seller does not have',
  approval: 'The purchase is priced above the approval threshold; the approver declines',
  uncertain: 'Payment response is lost; another attempted purchase must stop',
};
// Up to six decimals, at least two: 0.002111, 0.50, 0.00.
const usdc = (amount: number): string => amount.toFixed(6).replace(/0{1,4}$/, '');

export async function runDemoCase(name: DemoCase, serviceId = 'blockrun', print: (text: string) => void = console.log, policyPath = offlinePolicyPath) {
  const service = await loadService(serviceId);
  const scenario: Scenario = identityRules[name] ? 'answer' : name as Scenario;
  const policy = readPolicy(policyPath); policy.liveEnabled = true; // Only the fixture transport below is used.
  const request = caseRequest(service, scenario);
  const example = exampleCompany([service.definition.id]);
  const employee = name === 'unassigned' ? example.observer : example.employee;
  const agent = name === 'unknown-agent' ? newCredential('unknown-agent').credential
    : name === 'wrong-key' ? newCredential('research-agent').credential : example.agent;
  if (name === 'revoked') example.company.agents['research-agent']!.active = false;
  const binding = { request, service: service.definition, policy };
  const identity = new IdentitySession(signSession(example.company.companyId, employee, agent, binding), () => example.company);
  const transport = new FundedFixtureTransport(service, scenario);
  transport.fund(0.5);
  // Where the seller offers a choice, the person picks on screen in every case but scope, which shows the terminal flow where the agent names the model itself.
  const call = caseCall(service, scenario); const field = name === 'scope' ? undefined : choiceField(service, call.operation);
  const pick = field ? call.input[field] as string : undefined;
  const labels = optionLabels(service);
  const label = (value: string) => labels[value] ? `${labels[value]!.label} (${labels[value]!.provider})` : value;
  const events: unknown[] = [];
  let harness: Harness | undefined; let error: string | undefined; let passed = false;
  print(`\n${name}: ${descriptions[name]}\nRequest: ${request}\nIdentity: ${example.company.companyId} / ${employee.id} -> ${agent.id}`);
  try {
    harness = new Harness({ service, policy, transport, identity, request, live: true,
      approve: async (_text, details) => {
        const approved = name !== 'approval';
        print(`  Approval requested: ${details.priceUsdc} USDC for ${details.operation} on ${networkLabel(details.chain)}, above the ${policy.limits.approvalAboveUsdc} USDC threshold\n  Approver: ${approved ? 'APPROVED' : 'DECLINED'} (scripted)`);
        return approved;
      },
      ...(pick ? { choose: async (details: ChoiceDetails) => {
        for (const option of details.options) print(`  Quote: ${label(option.value).padEnd(32)}${option.quote ? `${usdc(option.quote.priceUsdc)} USDC on ${networkLabel(option.quote.chain)}` : 'no quote'}${option.refused ? ` | unavailable: ${option.refused.reason}` : ''}`);
        print(`  Person picks: ${label(pick)} (scripted)`); return pick;
      } } : {}) });
    const printed = new Set<string>();
    const trace = await invokeAgent(harness, scriptedModel(service, scenario, { chooser: Boolean(pick) }), { structured: true, events,
      onToolResult: () => {
        for (const record of harness!.records) if (record.outcome && !printed.has(record.id)) {
          printed.add(record.id);
          print(`  ${record.operation}: ${record.outcome}${record.quote ? ` | ${usdc(record.quote.priceUsdc)} USDC quoted` : ''}${record.reason ? ` | ${record.reason}` : ''}`);
          const text = completionText(record.payment?.output);
          if (text) print(`  Answer from ${label(String(record.chosen ?? (record.input as { model?: unknown }).model))}:\n${text.split('\n').map(line => line && `    ${line}`).join('\n')}`);
        }
      } });
    const answer = finalSchema.parse(JSON.parse(trace.messages.at(-1)!.text));
    print(`Agent: ${answer.summary}`);
    for (const reason of answer.unavailable) print(`Response: ${reason}`);
    passed = !identityRules[name] && score(harness, transport, scenario, trace.messages).completion
      && (name !== 'scope' || transport.quotes.length === 0);
  } catch (caught) {
    error = errorText(caught); print(`REFUSED: ${error}`);
    passed = caught instanceof Refusal && caught.rule === identityRules[name] && transport.quotes.length === 0 && transport.attempts.length === 0;
  }
  const spend = transport.effects.reduce((total, effect) => total + (effect.payment.amountUsdc ?? 0), 0);
  const modelCalls = events.filter(event => (event as { kind: string }).kind === 'model_input').length;
  print(`Confirmed simulated spend: ${usdc(spend)} USDC | Payment attempts: ${transport.attempts.length} | Model calls: ${modelCalls}`);
  print(`Operating wallet: ${transport.balanceUsdc === null ? 'unknown; reconcile' : usdc(transport.balanceUsdc) + ' USDC'} | Reserved: ${usdc((harness?.reservedMicro ?? 0) / 1e6)} USDC`);
  return { name, passed, error, spend, modelCalls, quotes: transport.quotes.length, attempts: transport.attempts.length, effects: transport.effects.length, records: harness?.records ?? [], balanceUsdc: transport.balanceUsdc };
}
async function main() {
  process.env.LANGSMITH_TRACING = 'false'; process.env.LANGCHAIN_TRACING_V2 = 'false';
  const { values } = args({ case: { type: 'string' }, list: { type: 'boolean' }, policy: { type: 'string', default: offlinePolicyPath } });
  if (values.help) { console.log(`bun run demo [--case ${demoCases.join('|')}] [--service blockrun|_template]\nNo credentials, network calls, wallet creation or real payments. Model choices, provider picks and the seller are scripted.`); return; }
  if (values.list) { for (const name of demoCases) console.log(`${name}: ${descriptions[name]}`); return; }
  const selected = values.case ? [values.case as DemoCase] : [...demoCases];
  if (selected.some(name => !demoCases.includes(name))) throw new Error('Unknown demo case. Use --list.');
  const serviceId = values.service as string || 'blockrun';
  printIntro((await loadService(serviceId)).definition.name);
  const results = [];
  for (const name of selected) results.push(await runDemoCase(name, serviceId, console.log, values.policy as string));
  console.log('\nCase             Check  Payments  Simulated USDC');
  for (const result of results) console.log(`${result.name.padEnd(17)}${(result.passed ? 'PASS' : 'FAIL').padEnd(7)}${String(result.effects).padEnd(10)}${result.balanceUsdc === null ? 'unknown' : usdc(result.spend)}`);
  console.log(`\n${results.filter(result => result.passed).length}/${results.length} checks passed. Each case starts with fresh identities, state and a 0.50 USDC simulated allocation.`);
  if (results.some(result => !result.passed)) process.exitCode = 1;
}
function printIntro(seller: string) {
  console.log(`Circle Agent Spend Lab | OFFLINE WALKTHROUGH\nExampleCo treasury -> research-agent operating wallet: 0.50 USDC (SIMULATED, fresh per case)\nEmployee and agent signatures are real local cryptographic checks.\nModel choices, provider picks, ${seller} quotes and answers, approvals and payments are scripted fixtures.`);
}
if (import.meta.main) main().catch(error => { console.error(errorText(error)); process.exitCode = 1; });
