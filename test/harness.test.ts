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

import { afterAll, test, expect } from 'bun:test';
import { readPolicy, root } from '../src/cli';
import { join } from 'node:path';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { loadService, parseDefinition } from '../src/service';
import { fixtureHarness, FixtureTransport, loadFixture, caseCall, firstOperation, offlinePolicyPath } from '../evals/fixtures';
import { casePolicy } from '../evals/cases';
import { micro } from '../src/types';
import { policySchema } from '../src/policy';
import { remainingPolicy } from '../src/setup';

const temporary: string[] = [];
afterAll(() => { for (const folder of temporary) rmSync(folder, { recursive: true, force: true }); });

const base = readPolicy(offlinePolicyPath);
const payee = base.services.blockrun!.payees[0]!;
test('omitting liveEnabled does not authorize live execution', () => {
  const raw = structuredClone(base) as Partial<typeof base>; delete raw.liveEnabled;
  expect(policySchema.parse(raw).liveEnabled).toBe(false);
});
async function setup(scenario: ConstructorParameters<typeof FixtureTransport>[1] = 'answer', approval = true, configure: (policy: typeof base) => void = () => {}) {
  const service = await loadService('blockrun'); const policy = structuredClone(base); policy.liveEnabled = true;
  configure(policy);
  const transport = new FixtureTransport(service, scenario);
  const harness = fixtureHarness({ service, policy, transport, live: true, request: transport.fixture.request, approve: async () => approval });
  return { service, policy, transport, harness, input: transport.fixture.input, pricey: transport.fixture.approvalInput! };
}
test('quote-only makes no payment and retains rehearsal reservation', async () => {
  const { service, policy, transport, input } = await setup();
  policy.liveEnabled = false;
  const harness = fixtureHarness({ service, policy, transport, request: 'Research' });
  expect((await harness.call('buy', 'chat_completion', input, 'Research')).outcome).toBe('quote_only');
  expect(transport.attempts).toHaveLength(0); expect(harness.reservedMicro).toBe(2111);
});
test('unapproved models, malformed input and unknown operations fail before quote', async () => {
  const { harness, transport, input } = await setup();
  for (const [op, value] of [['chat_completion', { ...input, model: 'anthropic/claude-opus-5.5' }], ['chat_completion', { prompt: input.prompt }], ['wallet_balances', {}],
    ['chat_completion', { ...input, url: 'https://evil.invalid' }], ['chat_completion', { ...input, model: 'Google/Gemini 2.5 Flash' }]] as const) {
    expect((await harness.call('buy', op, value, 'Research')).outcome).toBe('denied');
  }
  expect(harness.records.map(record => record.rule)).toEqual(['model', 'model', 'operation', 'input', 'input']);
  expect(transport.quotes).toHaveLength(0); expect(transport.effects).toHaveLength(0);
});
test('a policy that approves no models refuses every model before quote', async () => {
  const { harness, transport, input } = await setup('answer', true, policy => { policy.services.blockrun!.scope.models = []; });
  expect((await harness.call('buy', 'chat_completion', input, 'Research')).rule).toBe('model.scope'); expect(transport.quotes).toHaveLength(0);
});
test('unapproved service and live mode fail at construction', async () => {
  const { service, policy, transport } = await setup(); delete policy.services.blockrun;
  expect(() => fixtureHarness({ service, policy, transport, request: '' })).toThrow('not authorized');
  expect(() => fixtureHarness({ service, policy: { ...base, liveEnabled: false }, transport, live: true, request: '' })).toThrow('liveEnabled');
});
test('offline threshold: Gemini 2.5 Flash runs without approval; Claude Sonnet 5.5 and GPT-6.1 Sol need it', async () => {
  for (const [model, needsApproval] of [['google/gemini-2.5-flash', false], ['anthropic/claude-sonnet-5.5', true], ['openai/gpt-6.1-sol', true]] as const) {
    const asked: number[] = [];
    const { service, policy, transport, input } = await setup();
    const harness = fixtureHarness({ service, policy, transport, live: true, request: '', approve: async (_text, details) => { asked.push(details.priceUsdc); return true; } });
    expect((await harness.call('buy', 'chat_completion', { ...input, model }, 'Research')).outcome).toBe('simulated');
    expect(asked).toEqual(needsApproval ? [0.00574] : []);
  }
});
test('approval denial releases reservation before payment', async () => {
  const { harness, transport, pricey } = await setup('answer', false);
  expect((await harness.call('buy', 'chat_completion', pricey, 'Research')).outcome).toBe('approval_denied');
  expect(harness.reservedMicro).toBe(0); expect(harness.purchaseCount).toBe(0); expect(transport.effects).toHaveLength(0);
});
test('approval sees operation network recipient and purpose', async () => {
  const { service, policy, transport, pricey } = await setup();
  let prompt = '';
  const harness = fixtureHarness({ service, policy, transport, request: '', live: true, approve: async text => { prompt = text; return true; } });
  expect((await harness.call('buy', 'chat_completion', pricey, 'Monthly report')).outcome).toBe('simulated');
  for (const text of ['0.00574', 'chat_completion', 'ARC', payee, 'Monthly report', 'anthropic/claude-sonnet-5.5']) expect(prompt).toContain(text);
});
test('concurrent requests cannot overshoot budget', async () => {
  const service = await loadService('blockrun'); const transport = new FixtureTransport(service, 'budget'); const input = transport.fixture.input;
  const harness = fixtureHarness({ service, policy: casePolicy(base, service, 'budget'), transport, live: true, request: transport.fixture.request, approve: async () => true });
  const results = await Promise.all(Array.from({ length: 3 }, () => harness.call('buy', 'chat_completion', input, 'Research')));
  expect(results.filter(r => r.outcome === 'simulated')).toHaveLength(2); expect(harness.reservedMicro).toBe(400000);
  expect(transport.effects).toHaveLength(2); expect(results.some(r => r.rule === 'budget')).toBe(true);
});
test('purchase count differs from rate limiting', async () => {
  const { harness, input, transport } = await setup('answer', true, policy => { policy.limits.maxPurchases = 1; });
  await harness.call('buy', 'chat_completion', input, 'Research');
  expect((await harness.call('buy', 'chat_completion', input, 'Research')).rule).toBe('count'); expect(transport.effects).toHaveLength(1);
});
test('a chat with no purchases left refuses the next one with the count rule', async () => {
  const { service, policy, transport, input } = await setup();
  const turn = remainingPolicy(policy, 0, policy.limits.maxPurchases); expect(turn.limits.maxPurchases).toBe(0);
  const harness = fixtureHarness({ service, policy: turn, transport, live: true, request: '' });
  expect((await harness.call('buy', 'chat_completion', input, 'Research')).rule).toBe('count'); expect(transport.attempts).toHaveLength(0);
});
test('unknown outcome retains reservation and stops queued concurrent payments', async () => {
  const { harness, transport, input } = await setup('uncertain');
  await Promise.all([harness.call('buy', 'chat_completion', input, 'Research'), harness.call('buy', 'chat_completion', input, 'Research')]);
  expect(transport.attempts).toHaveLength(1); expect(harness.reservedMicro).toBe(2111); expect(harness.halted).toContain('reconciliation');
  const quotes = transport.quotes.length; await harness.call('buy', 'chat_completion', input, 'Retry'); expect(transport.quotes.length).toBe(quotes);
});
test('execution price change releases reservation without effect', async () => {
  const { harness, transport, input } = await setup('changed-price');
  expect((await harness.call('buy', 'chat_completion', input, 'Research')).outcome).toBe('failed'); expect(harness.reservedMicro).toBe(0); expect(transport.effects).toHaveLength(0);
});
test('a quote above the operation cap is refused before payment', async () => {
  const { harness, transport, input } = await setup('price');
  expect((await harness.call('buy', 'chat_completion', input, 'Research')).rule).toBe('price'); expect(transport.attempts).toHaveLength(0); expect(harness.reservedMicro).toBe(0);
});
test('invalid price, network and recipient cannot reach payment', async () => {
  for (const quote of [{ priceUsdc: NaN, chain: 'ARC', payee }, { priceUsdc: 0.002, chain: 'BASE', payee }, { priceUsdc: 0.002, chain: 'ARC', payee: 'bad' }, { priceUsdc: 0.002, chain: 'ARC', payee: '0x' + '9'.repeat(40) }]) {
    const { harness, transport, input } = await setup(); transport.quote = async () => quote;
    expect((await harness.call('buy', 'chat_completion', input, 'Research')).outcome).toBe('denied'); expect(transport.attempts).toHaveLength(0);
  }
});
test('reported overpayment halts later purchases and retains ceiling', async () => {
  const { harness, transport, input } = await setup(); transport.pay = async () => ({ output: {}, amountUsdc: 0.003, seller: payee, simulated: true });
  await harness.call('buy', 'chat_completion', input, 'Research'); expect(harness.halted).toContain('ceiling'); expect(harness.reservedMicro).toBe(2111);
  expect((await harness.call('buy', 'chat_completion', input, 'Research')).rule).toBe('reconcile');
});
test('a payment to anyone but the pinned payee halts later purchases', async () => {
  const { harness, transport, input } = await setup(); transport.pay = async (_request, ceiling) => ({ output: {}, amountUsdc: ceiling, seller: '0x' + '9'.repeat(40), simulated: true });
  await harness.call('buy', 'chat_completion', input, 'Research'); expect(harness.halted).toContain('recipient');
  expect((await harness.call('buy', 'chat_completion', input, 'Research')).rule).toBe('reconcile');
});
test('cancelled run does not execute after delayed approval', async () => {
  const { service, policy, transport, pricey } = await setup();
  let approve!: (answer: boolean) => void;
  const harness = fixtureHarness({ service, policy, transport, live: true, request: '', approve: () => new Promise(resolve => { approve = resolve; }) });
  const pending = harness.call('buy', 'chat_completion', pricey, 'Research'); await Bun.sleep(1); harness.cancel(); approve(true); await pending;
  expect(transport.effects).toHaveLength(0); expect(harness.reservedMicro).toBe(0);
});
test('second service uses generic core with no adapter', async () => {
  const service = await loadService('_template'); const policy = structuredClone(base); policy.liveEnabled = true;
  const transport = new FixtureTransport(service); const harness = fixtureHarness({ service, policy, transport, live: true, request: '', approve: async () => true });
  expect((await harness.call('buy', firstOperation(service), caseCall(service, 'answer').input, 'Research')).outcome).toBe('simulated'); expect(service.adapter).toEqual({});
  expect(transport.effects[0]!.request.url).toBe('https://data.example.invalid/metrics?asset=USDC&period=2026-09');
});
test('a new service loads without its own fixture or core changes', async () => {
  mkdirSync(join(root, 'runs'), { recursive: true });
  const folder = mkdtempSync(join(root, 'runs', 'adapter-test-')); temporary.push(folder);
  cpSync(join(root, 'services/_template'), join(folder, 'another_data'), { recursive: true });
  const definition = JSON.parse(readFileSync(join(folder, 'another_data/service.json'), 'utf8')); definition.id = 'another_data';
  writeFileSync(join(folder, 'another_data/service.json'), JSON.stringify(definition));
  const service = await loadService('another_data', folder); const policy = structuredClone(base); policy.liveEnabled = true;
  const transport = new FixtureTransport(service, 'answer', loadFixture(await loadService('_template')));
  expect(() => fixtureHarness({ service, policy, transport, request: '' })).toThrow('not authorized');
  policy.services.another_data = structuredClone(policy.services.example!);
  const harness = fixtureHarness({ service, policy, transport, live: true, request: '', approve: async () => true });
  expect((await harness.call('buy', 'metrics', { asset: 'USDC', period: '2026-09' }, 'Research')).outcome).toBe('simulated');
  expect(service.adapter).toEqual({});
});
test('interruption records uncertainty while payment is in flight', async () => {
  const { harness, transport, input } = await setup();
  let finish!: (payment: Awaited<ReturnType<typeof transport.pay>>) => void;
  transport.pay = () => new Promise(resolve => { finish = resolve; });
  const pending = harness.call('buy', 'chat_completion', input, 'Research'); await Bun.sleep(1);
  harness.cancel(); expect(harness.records[0]!.outcome).toBe('unknown_reconcile'); expect(harness.reservedMicro).toBe(2111);
  finish({ output: {}, simulated: true, amountUsdc: 0.002111, seller: payee }); await pending;
  expect(harness.halted).toContain('interrupted');
});
test('unsupported schemas, unsafe origins and unsafe paths fail', async () => {
  const service = await loadService('_template'); const raw = structuredClone(service.definition);
  raw.operations.metrics!.inputSchema = { type: 'object', additionalProperties: false, oneOf: [] }; expect(() => parseDefinition(raw)).toThrow('Unsupported');
  raw.baseUrl = 'https://user:password@example.invalid'; expect(() => parseDefinition(raw)).toThrow();
  for (const path of ['/metrics/{item}', '/metrics/../admin', '//elsewhere.example/metrics', '/metrics?x=1']) {
    const unsafe = structuredClone(service.definition); unsafe.operations.metrics!.path = path;
    expect(() => parseDefinition(unsafe)).toThrow('Unsafe operation path');
  }
});
test('micro-USDC rejects invalid precision and roundoff remains stable', () => {
  expect(micro(0.1 + 0.2)).toBe(300000); expect(micro(0.002111)).toBe(2111); expect(() => micro(0.0000001)).toThrow(); expect(() => micro(-1)).toThrow();
});
