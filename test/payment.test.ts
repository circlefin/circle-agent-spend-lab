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
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforePayment, parseUsdc, receiptTx, circleTransport } from '../payments/circle';
import { loadPayment } from '../src/payment';
import { root } from '../src/cli';
import { initializeCompany } from '../src/company';

const temporary: string[] = [];
afterAll(() => { for (const folder of temporary) rmSync(folder, { recursive: true, force: true }); });
function temporaryApp() {
  mkdirSync(join(root, 'runs'), { recursive: true });
  const folder = mkdtempSync(join(root, 'runs', 'payment-test-')); temporary.push(folder);
  mkdirSync(join(folder, 'payments'));
  return folder;
}
test('CLI amounts are parsed strictly', () => {
  expect(parseUsdc('$0.13 USDC')).toBe(0.13); expect(parseUsdc('0.01')).toBe(0.01);
  for (const value of ['not money', '-0.1', 'NaN', '1 ETH', 'price 5 then 20', '0.0000001']) expect(() => parseUsdc(value)).toThrow();
});
test('receipts expose only validated transaction hashes', () => {
  const tx = '0x' + 'a'.repeat(64);
  expect(receiptTx(Buffer.from(JSON.stringify({ transaction: tx })).toString('base64'))).toBe(tx);
  expect(receiptTx('not JSON')).toBeUndefined(); expect(receiptTx(Buffer.from('{"transaction":"fake"}').toString('base64'))).toBeUndefined();
});
test('only CLI errors from before payment release the reservation', () => {
  for (const text of ['Execution quote exceeds --max-amount', 'insufficient USDC balance', 'wallet not deployed']) expect(beforePayment.test(text)).toBe(true);
  for (const text of ['socket hang up', 'HTTP 502']) expect(beforePayment.test(text)).toBe(false);
});
test('invalid wallet address fails without invoking CLI', () => { expect(() => circleTransport('bad', 'BASE')).toThrow(); });

test('payment selection rejects paths, absent adapters and malformed contracts', async () => {
  const folder = temporaryApp(); const directory = join(folder, 'payments');
  const options = { chain: 'BASE', live: false };
  for (const id of ['../circle', '/circle', 'https://example.invalid/wallet', 'circle.ts'])
    await expect(loadPayment(id, options, directory)).rejects.toThrow('Invalid local payment');
  await expect(loadPayment('missing', options, directory)).rejects.toThrow('not installed');
  writeFileSync(join(directory, 'not_factory.ts'), 'export default {};');
  await expect(loadPayment('not_factory', options, directory)).rejects.toThrow('default factory');
  writeFileSync(join(directory, 'incomplete.ts'), 'export default () => ({ quote() {} });');
  await expect(loadPayment('incomplete', options, directory)).rejects.toThrow('quote and pay');
});

test('terminal runs with another adapter and no Circle, preserving quote-only and live gates', async () => {
  for (const [live, enabled] of [[false, true], [true, false], [true, true]] as const) {
    const folder = temporaryApp();
    cpSync(join(root, 'src'), join(folder, 'src'), { recursive: true });
    cpSync(join(root, 'services/_template'), join(folder, 'services/_template'), { recursive: true });
    const policy = JSON.parse(readFileSync(join(root, 'evals', 'offline-policy.json'), 'utf8')); policy.liveEnabled = enabled;
    writeFileSync(join(folder, 'policy.json'), JSON.stringify(policy));
    initializeCompany(join(folder, '.local'));
    const registryPath = join(folder, '.local/company.json');
    const registry = JSON.parse(readFileSync(registryPath, 'utf8')); registry.agents['research-agent'].services = ['example'];
    writeFileSync(registryPath, JSON.stringify(registry));
    writeFileSync(join(folder, 'payments/alternate.ts'), `
      import { writeFileSync } from 'node:fs';
      export default ({ chain, live }) => {
        writeFileSync(new URL('../setup.json', import.meta.url), JSON.stringify({ chain, live }));
        return {
          async quote() { return { priceUsdc: 0.002, payee: '0x1111111111111111111111111111111111111111', chain }; },
          async pay(request, ceiling, paymentId) {
            writeFileSync(new URL('../paid.json', import.meta.url), JSON.stringify({ request, ceiling, paymentId }));
            return { output: { synthetic: true, value: 42 }, amountUsdc: ceiling, simulated: true };
          }
        };
      };
    `);
    let modelCalls = 0; let toolOutput = '';
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      const body = await request.json() as { messages: Array<{ role: string; content: string }> };
      toolOutput = body.messages.find(message => message.role === 'tool')?.content ?? '';
      modelCalls++;
      return Response.json({ id: `chatcmpl_${modelCalls}`, object: 'chat.completion', created: 0, model: 'fixture-model', choices: [{ index: 0,
        message: modelCalls === 1 ? { role: 'assistant', content: null, tool_calls: [{ id: 'call_test', type: 'function', function: {
          name: 'buy', arguments: JSON.stringify({ operation: 'metrics', input: { asset: 'USDC', period: '2026-09' }, purpose: 'Synthetic research' })
        } }] } : { role: 'assistant', content: 'Fixture completed' }, finish_reason: modelCalls === 1 ? 'tool_calls' : 'stop' }] });
    } });
    const child = Bun.spawn([process.execPath, join(folder, 'src/main.ts'), '--service', '_template', '--payment', 'alternate', '--prompt', 'Read synthetic metrics', ...(live ? ['--live'] : [])], {
      cwd: folder, stdout: 'pipe', stderr: 'pipe',
      env: { OPENAI_API_KEY: 'fixture-not-a-key', OPENAI_MODEL: 'fixture-model', OPENAI_API_MODE: 'chat_completions', OPENAI_BASE_URL: `http://127.0.0.1:${server.port}/v1` },
    });
    const timer = setTimeout(() => child.kill(), 10000);
    try {
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(existsSync(join(folder, 'payments/circle.ts'))).toBe(false);
      if (live && !enabled) {
        expect(code).toBe(1); expect(stderr).toContain('policy.liveEnabled is false'); expect(modelCalls).toBe(0);
        expect(existsSync(join(folder, 'setup.json'))).toBe(false); expect(existsSync(join(folder, 'paid.json'))).toBe(false);
        continue;
      }
      expect(code).toBe(0); expect(stderr).toBe(''); expect(modelCalls).toBe(2);
      expect(stdout).toContain('payment alternate'); expect(stdout).toContain(live ? 'LIVE PAYMENT' : 'QUOTE ONLY');
      expect(JSON.parse(readFileSync(join(folder, 'setup.json'), 'utf8'))).toEqual({ chain: 'BASE', live });
      expect(existsSync(join(folder, 'paid.json'))).toBe(live);
      expect(JSON.parse(toolOutput).outcome).toBe(live ? 'simulated' : 'quote_only');
      if (live) expect(JSON.parse(readFileSync(join(folder, 'paid.json'), 'utf8')).ceiling).toBe(0.002);
      const run = readdirSync(join(folder, 'runs')).find(name => name.startsWith('agent-'))!;
      const records = JSON.parse(readFileSync(join(folder, 'runs', run, 'records.json'), 'utf8'));
      expect(records[0].outcome).toBe(live ? 'simulated' : 'quote_only');
    } finally { clearTimeout(timer); child.kill(); server.stop(true); }
  }
}, 30000);
