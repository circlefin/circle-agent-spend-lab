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

import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { initializeCompany, loadIdentity } from '../src/company';
import { readPolicy, root } from '../src/cli';
import { Harness } from '../src/harness';
import { exampleCompany, IdentitySession, newCredential, signSession, type Binding } from '../src/identity';
import { loadService } from '../src/service';
import { invokeAgent } from '../src/agent';
import { fixtureHarness, FixtureTransport, FundedFixtureTransport, offlinePolicyPath } from '../evals/fixtures';
import { scriptedModel } from '../evals/cases';
import { demoCases, runDemoCase } from '../evals/demo';

const temporary: string[] = [];
afterAll(() => { for (const folder of temporary) rmSync(folder, { recursive: true, force: true }); });
function temporaryFolder(prefix: string): string {
  mkdirSync(join(root, 'runs'), { recursive: true });
  const folder = mkdtempSync(join(root, 'runs', prefix)); temporary.push(folder); return folder;
}
async function setup() {
  const service = await loadService('blockrun'); const policy = readPolicy(offlinePolicyPath); policy.liveEnabled = true;
  const transport = new FixtureTransport(service); const request = transport.fixture.request;
  const example = exampleCompany(); const binding: Binding = { request, service: service.definition, policy };
  const proof = signSession(example.company.companyId, example.employee, example.agent, binding);
  const identity = new IdentitySession(proof, () => example.company);
  return { ...example, binding, proof, identity, service, policy, transport, request };
}
test('employee and agent signatures bind the task, service and policy', async () => {
  const s = await setup(); expect(s.identity.check(s.binding).employeeId).toBe('analyst');
  for (const binding of [{ ...s.binding, request: 'Another task' }, { ...s.binding, policy: {} }, { ...s.binding, service: { id: 'example' } }])
    expect(() => s.identity.check(binding)).toThrow('changed after signing');
  const forged = structuredClone(s.proof); forged.context.employeeId = 'observer';
  expect(() => new IdentitySession(forged, () => s.company).check(s.binding)).toThrow('signature');
});
test('expired, future and cross-company contexts are refused', async () => {
  const s = await setup();
  expect(() => s.identity.check(s.binding, s.proof.context.expiresAt)).toThrow('expired');
  expect(() => s.identity.check(s.binding, s.proof.context.issuedAt - 6000)).toThrow('invalid timing');
  s.company.companyId = 'another-company'; expect(() => s.identity.check(s.binding)).toThrow('another company');
});
test('sessions cannot be admitted twice in one process', async () => {
  const s = await setup(); s.identity.admit(s.binding);
  expect(() => new IdentitySession(s.proof, () => s.company).admit(s.binding)).toThrow('already used');
});
test('copying an approved agent ID without its key is refused', async () => {
  const s = await setup(); const wrong = newCredential('research-agent').credential;
  const forged = signSession(s.company.companyId, s.employee, wrong, s.binding);
  expect(() => new Harness({ ...s, identity: new IdentitySession(forged, () => s.company), live: true })).toThrow('signature');
  expect(s.transport.quotes).toHaveLength(0); expect(s.transport.attempts).toHaveLength(0);
});
test('copying an employee ID without its key cannot authorize a task', async () => {
  const s = await setup(); const wrong = newCredential('analyst').credential;
  const forged = signSession(s.company.companyId, wrong, s.agent, s.binding);
  expect(() => new IdentitySession(forged, () => s.company).check(s.binding)).toThrow('signature');
});
test('identity cannot be omitted from a direct harness invocation', async () => {
  const s = await setup();
  expect(() => new Harness({ ...s, identity: undefined as unknown as IdentitySession })).toThrow('verified identity');
  expect(s.transport.quotes).toHaveLength(0);
});
test('inactive employee and unassigned service fail before quote', async () => {
  const s = await setup(); s.company.employees.analyst!.active = false;
  expect(() => new Harness({ ...s, live: true })).toThrow('inactive');
  s.company.employees.analyst!.active = true; s.company.agents['research-agent']!.services = [];
  expect(() => new Harness({ ...s, live: true })).toThrow('not assigned to this service'); expect(s.transport.quotes).toHaveLength(0);
});
test('revocation before starting the graph prevents model inference', async () => {
  const s = await setup(); const harness = new Harness({ ...s, live: true });
  s.company.agents['research-agent']!.active = false;
  const model = scriptedModel(s.service, 'answer'); let modelCalls = 0;
  model._generate = async () => { modelCalls++; throw new Error('Must not reach the model'); };
  await expect(invokeAgent(harness, model)).rejects.toThrow('revoked');
  expect(modelCalls).toBe(0); expect(s.transport.quotes).toHaveLength(0);
});
test('revocation during quote prevents reservation and payment', async () => {
  const s = await setup(); const quote = s.transport.quote.bind(s.transport);
  s.transport.quote = async request => { const result = await quote(request); s.company.agents['research-agent']!.active = false; return result; };
  const harness = new Harness({ ...s, live: true });
  expect((await harness.call('buy', 'chat_completion', s.transport.fixture.input, 'Research')).rule).toBe('identity.agent');
  expect(harness.reservedMicro).toBe(0); expect(s.transport.attempts).toHaveLength(0);
});
for (const change of ['revoke', 'unassign', 'rotate-key'] as const) test(`${change} while awaiting approval prevents execution and releases reservation`, async () => {
  const s = await setup(); s.policy.limits.approvalAboveUsdc = 0;
  const proof = signSession(s.company.companyId, s.employee, s.agent, s.binding);
  const identity = new IdentitySession(proof, () => s.company);
  let decide!: (value: boolean) => void; let waiting!: () => void;
  const approvalStarted = new Promise<void>(resolve => { waiting = resolve; });
  const harness = new Harness({ ...s, identity, live: true, approve: () => { waiting(); return new Promise(resolve => { decide = resolve; }); } });
  const pending = harness.call('buy', 'chat_completion', s.transport.fixture.input, 'Research'); await approvalStarted;
  expect(harness.reservedMicro).toBe(2111);
  if (change === 'revoke') s.company.agents['research-agent']!.active = false;
  if (change === 'unassign') s.company.agents['research-agent']!.employees = [];
  if (change === 'rotate-key') s.company.agents['research-agent']!.publicKey = newCredential('replacement').publicKey;
  decide(true); const result = await pending;
  expect(result.outcome).toBe('denied'); expect(harness.reservedMicro).toBe(0); expect(s.transport.attempts).toHaveLength(0);
});
test('changed signed policy is refused before a further quote', async () => {
  const s = await setup(); const harness = new Harness({ ...s, live: true }); s.policy.limits.sessionUsdc = 10;
  expect((await harness.call('buy', 'chat_completion', s.transport.fixture.input, 'Research')).rule).toBe('identity.context');
  expect(s.transport.quotes).toHaveLength(0);
});
test('registry failure is closed and does not disclose local error details to tools', async () => {
  const s = await setup(); let available = true;
  const identity = new IdentitySession(s.proof, () => { if (!available) throw new Error('private filesystem detail'); return s.company; });
  const harness = new Harness({ ...s, identity, live: true }); available = false;
  const result = await harness.call('buy', 'chat_completion', s.transport.fixture.input, 'Research');
  expect(result.rule).toBe('identity.registry'); expect(JSON.stringify(result)).not.toContain('private filesystem detail'); expect(s.transport.quotes).toHaveLength(0);
});
test('records carry verified public context, without keys or signatures', async () => {
  const s = await setup(); const harness = new Harness({ ...s, live: true, approve: async () => true });
  await harness.call('quote', 'chat_completion', s.transport.fixture.input);
  const events: unknown[] = []; await invokeAgent(harness, scriptedModel(s.service, 'answer'), { events });
  const serialized = JSON.stringify({ records: harness.records, events });
  expect(harness.records[0]!.identity?.agentId).toBe('research-agent');
  expect(serialized).not.toContain('PRIVATE KEY'); expect(serialized).not.toContain(s.proof.agentSignature);
});
test('company initialization protects local files and never overwrites keys', async () => {
  const directory = join(temporaryFolder('company-test-'), 'company'); initializeCompany(directory);
  expect(statSync(directory).mode & 0o777).toBe(0o700); expect(statSync(join(directory, 'agent.json')).mode & 0o777).toBe(0o600);
  const initial = readFileSync(join(directory, 'agent.json'), 'utf8'); expect(() => initializeCompany(directory)).toThrow('already exists');
  expect(readFileSync(join(directory, 'agent.json'), 'utf8')).toBe(initial);
  const s = await setup(); const identity = loadIdentity(directory, join(directory, 'employee.json'), join(directory, 'agent.json'), s.binding);
  expect(identity.check(s.binding).employeeId).toBe('analyst');
  const registry = JSON.parse(readFileSync(join(directory, 'company.json'), 'utf8')); registry.agents['research-agent'].active = false;
  writeFileSync(join(directory, 'company.json'), JSON.stringify(registry)); expect(() => identity.check(s.binding)).toThrow('revoked');
});
test('terminal rejects an unassigned employee before model setup or payment adapter loading', async () => {
  const directory = join(temporaryFolder('identity-cli-'), 'company'); initializeCompany(directory);
  const { request } = await setup();
  const child = Bun.spawn([process.execPath, join(root, 'src/main.ts'), '--company', directory, '--employee', join(directory, 'observer.json'),
    '--service', 'blockrun', '--payment', 'not-installed', '--prompt', request], {
    cwd: root, stdout: 'pipe', stderr: 'pipe', env: { LANGSMITH_TRACING: 'false', LANGCHAIN_TRACING_V2: 'false' },
  });
  const before = new Set(readdirSync(join(root, 'runs')));
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(code).toBe(1); expect(stderr).toContain('not assigned to this agent'); expect(stderr).not.toContain('not installed');
  // The refusal is still on the record, with its SAFR outcome.
  const created = readdirSync(join(root, 'runs')).filter(name => !before.has(name) && name.startsWith('agent-'));
  for (const name of created) temporary.push(join(root, 'runs', name));
  expect(created).toHaveLength(1);
  const lines = readFileSync(join(root, 'runs', created[0]!, 'journal.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(lines).toEqual([expect.objectContaining({ stage: 'refused_before_run', outcome: 'denied', rule: 'identity.assignment', safr: { outcome: 'deny', decidedBy: 'agent_identity' } })]);
});
test('simulated funding is separate; available balance and policy caps both apply', async () => {
  const s = await setup(); const transport = new FundedFixtureTransport(s.service);
  const harness = fixtureHarness({ ...s, transport, live: true });
  expect((await harness.call('buy', 'chat_completion', transport.fixture.input, 'Research')).outcome).toBe('failed');
  expect(transport.effects).toHaveLength(0); expect(harness.reservedMicro).toBe(0);
  transport.fund(0.002111);
  expect((await harness.call('buy', 'chat_completion', transport.fixture.input, 'Research')).outcome).toBe('simulated');
  expect(transport.balanceUsdc).toBe(0);
  const depleted = await harness.call('buy', 'chat_completion', transport.fixture.input, 'Research');
  expect(depleted).toMatchObject({ outcome: 'failed', message: 'Operating wallet has insufficient funds' }); expect(harness.reservedMicro).toBe(2111);
  transport.quote = async () => ({ priceUsdc: 1, chain: 'ARC', payee: transport.fixture.payee }); transport.fund(5);
  expect((await harness.call('buy', 'chat_completion', transport.fixture.input, 'Research')).rule).toBe('price');
  expect(transport.effects).toHaveLength(1);
});
for (const name of demoCases) test(`documented walkthrough: ${name}`, async () => {
  const printed: string[] = [];
  const result = await runDemoCase(name, 'blockrun', text => { printed.push(text); });
  expect(result.passed).toBe(true);
  if (['unassigned', 'unknown-agent', 'wrong-key', 'revoked'].includes(name)) { expect(result.modelCalls).toBe(0); expect(result.quotes).toBe(0); }
  if (name === 'answer') {
    expect(result.spend).toBe(0.002111); expect(result.balanceUsdc).toBe(0.497889); expect(result.quotes).toBe(4);
    expect(result.records[0]).toMatchObject({ chosen: 'google/gemini-2.5-flash', outcome: 'simulated' }); expect(result.records[0]!.approved).toBeUndefined();
    expect(printed.join('\n')).toContain('Emerging payment rails for AI agents include traditional financial networks');
  }
  if (name === 'scope') { expect(result.quotes).toBe(0); expect(result.records[0]).toMatchObject({ outcome: 'denied', rule: 'model' }); }
  if (name === 'unsupported') { expect(result.records).toHaveLength(0); expect(result.quotes).toBe(0); }
  if (name === 'approval') { expect(result.effects).toBe(0); expect(result.records[0]).toMatchObject({ chosen: 'anthropic/claude-sonnet-5.5', approved: false, outcome: 'approval_denied' }); }
  if (name === 'uncertain') { expect(result.attempts).toBe(1); expect(result.balanceUsdc).toBeNull(); }
});
