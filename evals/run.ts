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

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { args, readPolicy, outputFolder, save, root } from '../src/cli';
import { loadService } from '../src/service';
import { authorize } from '../src/policy';
import { Harness } from '../src/harness';
import { FixtureTransport, loadFixture, offlinePolicyPath, scenarios, type Scenario } from './fixtures';
import { caseHarness, caseRequest, caseExpectations, caseConditions, scriptedModel } from './cases';
import { invokeAgent, makeModel, modelProfileSchema } from '../src/agent';
import { score } from './score';
import { errorText } from '../src/types';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export interface TrialResult {
  profile: string; scenario: Scenario; trial: number; latencyMs: number;
  metrics?: ReturnType<typeof score>; error?: string; response?: string;
  records: Harness['records']; effects: FixtureTransport['effects'];
}
const cell = (value: unknown) => String(value).replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
function table(headers: string[], rows: unknown[][]): string {
  return [headers, headers.map(() => '---'), ...rows].map(row => '| ' + row.map(cell).join(' | ') + ' |').join('\n');
}
function responseExcerpt(result: TrialResult): string {
  if (result.error) return result.error.slice(0, 200);
  try {
    const answer = JSON.parse(result.response ?? '');
    const purchases = Array.isArray(answer.purchases) ? answer.purchases : [];
    const limitations = Array.isArray(answer.unavailable) ? answer.unavailable : [];
    const text = [...purchases.map((purchase: Record<string, unknown>) => `${purchase.model ?? purchase.operation}: ${purchase.costUsdc} USDC`), ...(typeof answer.summary === 'string' ? [answer.summary] : []), ...limitations].join('; ');
    return text.length > 200 ? text.slice(0, 197) + '...' : text || 'No purchases or explanation';
  } catch { return (result.response ?? 'No final response').slice(0, 200); }
}
export const failedTrial = (result: TrialResult): boolean => Boolean(result.error) || !result.metrics?.completion;
export function renderReport(results: TrialResult[]): string {
  const profiles = [...new Set(results.map(result => result.profile))];
  const summary = profiles.map(profile => {
    const trials = results.filter(result => result.profile === profile);
    const sum = (field: 'forbiddenAttempts' | 'forbiddenEffects' | 'refusedCalls' | 'unnecessaryPurchases') => trials.reduce((total, result) => total + (result.metrics?.[field] ?? 0), 0);
    const spend = trials.flatMap(result => result.effects).reduce((total, effect) => total + (effect.payment.amountUsdc ?? 0), 0);
    const times = trials.map(result => result.latencyMs).sort((a, b) => a - b);
    const median = (times[Math.floor((times.length - 1) / 2)]! + times[Math.floor(times.length / 2)]!) / 2;
    const usage = trials.filter(result => result.metrics?.usage.measuredMessages);
    const tokens = usage.length ? `${usage.reduce((n, result) => n + result.metrics!.usage.inputTokens!, 0)}/${usage.reduce((n, result) => n + result.metrics!.usage.outputTokens!, 0)} (${usage.length}/${trials.length} trials)` : 'unknown';
    const passes = (field: 'taskSucceeded' | 'toolOutcomeCorrect' | 'validFinalAnswer') => `${trials.filter(result => result.metrics?.[field] === true).length}/${trials.length}`;
    const unassessed = trials.filter(result => result.metrics?.taskSucceeded === null || !result.metrics).length;
    const waste = trials.reduce((total, result) => total + (result.metrics?.unnecessarySpendUsdc ?? 0), 0);
    return { score: [profile, `${passes('taskSucceeded')} (${unassessed} unassessed)`, passes('toolOutcomeCorrect'), passes('validFinalAnswer'), `${trials.filter(result => !failedTrial(result)).length}/${trials.length}`, waste.toFixed(3), `${sum('forbiddenAttempts')}/${sum('forbiddenEffects')}`],
      resources: [profile, trials.length, trials.filter(result => result.error).length, spend.toFixed(3), sum('refusedCalls'), (median / 1000).toFixed(2), tokens] };
  });
  const responses = results.map(result => [result.profile, result.scenario, result.trial, result.metrics?.taskSucceeded === true ? 'PASS' : result.metrics?.taskSucceeded === false ? 'FAIL' : 'UNASSESSED', result.metrics?.validFinalAnswer ? 'PASS' : 'FAIL', failedTrial(result) ? 'FAIL' : 'PASS', responseExcerpt(result),
    result.metrics?.failureReasons.join('; ') || (result.error ? 'Run error' : '')]);
  return '## Scores\n\n' + table(['Model', 'Task checks', 'Tool outcomes', 'Strict JSON', 'Full contract', 'Unnecessary USDC', 'Forbidden attempts/effects'], summary.map(row => row.score))
    + '\n\n## Resources\n\n' + table(['Model', 'Trials', 'Errors', 'Simulated USDC', 'Refusals', 'Median seconds', 'Tokens in/out'], summary.map(row => row.resources))
    + '\n\n## Responses\n\n' + table(['Model', 'Case', 'Trial', 'Task', 'JSON', 'Full contract', 'Purchases, summary or limitation excerpt', 'Failure reason'], responses)
    + '\n\nSeller data and payments are synthetic. Tool outcomes use recorded calls and effects, independent of final formatting. Task checks compare the reported purchases with the recorded ones and assess one schema-valid JSON object, optionally inside a single Markdown fence; other prose is unassessed. Full contract also requires strict JSON and correct payment status. Unnecessary spend covers predefined no-purchase cases. Unknown or unassessed is not a pass. Unknown usage is not zero.\n';
}
async function main() {
  const { values } = args({ model: { type: 'string' }, models: { type: 'string' }, list: { type: 'boolean' }, repeat: { type: 'string', default: '1' }, case: { type: 'string' }, 'output-dir': { type: 'string' }, 'dry-run': { type: 'boolean' }, offline: { type: 'boolean' }, policy: { type: 'string', default: offlinePolicyPath } });
  if (values.offline || values['dry-run']) { process.env.LANGSMITH_TRACING = 'false'; process.env.LANGCHAIN_TRACING_V2 = 'false'; }
  if (values.help) { console.log('bun run eval --service blockrun --model MODEL [--case answer,scope]\nbun run eval --service blockrun --models evals/models.example.json\nbun run eval --service blockrun --offline\nbun run eval --service blockrun --list\nOnly candidate model inference is live. Seller and payment I/O stay synthetic. Optional: --repeat N; --dry-run checks configuration without inference.'); return; }
  if (!values.service) throw new Error('--service is required');
  const repeat = Number(values.repeat); if (!Number.isInteger(repeat) || repeat < 1 || repeat > 100) throw new Error('--repeat must be an integer from 1 to 100');
  const service = await loadService(values.service as string); const base = readPolicy(values.policy as string); authorize(base, service.definition.id);
  const fixture = loadFixture(service);
  const cases = values.case ? [...new Set(String(values.case).split(',').map(value => value.trim()))] as Scenario[] : scenarios.filter(scenario => values.offline || values.list || scenario !== 'budget');
  if (cases.some(scenario => !scenarios.includes(scenario))) throw new Error('Unknown case');
  if (values.list) { console.log(table(['Case', 'User request', 'Supplied condition', 'Expected behaviour'], cases.map(scenario => [scenario, caseRequest(service, scenario), caseConditions[scenario], caseExpectations[scenario]]))); return; }
  if ([values.model, values.models, values.offline].filter(Boolean).length !== 1) throw new Error('Choose --model MODEL, --models FILE or --offline');
  if (!values.offline && cases.includes('budget')) throw new Error('The budget case is a scripted concurrency probe. Use --offline --case budget; real-model comparisons use natural requests.');
  const profiles = values.offline ? [{ name: 'scripted-fixture', model: 'offline', apiMode: 'chat_completions' as const, apiKeyEnv: '' }]
    : values.model ? [modelProfileSchema.parse({ name: values.model, model: values.model, apiMode: process.env.OPENAI_API_MODE ?? 'responses', apiKeyEnv: 'OPENAI_API_KEY', ...(process.env.OPENAI_BASE_URL ? { baseUrlEnv: 'OPENAI_BASE_URL' } : {}) })]
    : z.array(modelProfileSchema).min(1).parse(JSON.parse(readFileSync(values.models as string, 'utf8')));
  if (new Set(profiles.map(p => p.name)).size !== profiles.length) throw new Error('Model profile names must be unique');
  if (values['dry-run']) { console.log(JSON.stringify({ service: service.definition.id, models: profiles.map(p => ({ name: p.name, model: p.model, apiMode: p.apiMode })), cases, repeat, trials: profiles.length * cases.length * repeat, networkCalls: 0 }, null, 2)); return; }
  const folder = outputFolder('eval', values['output-dir'] as string | undefined); const results: TrialResult[] = [];
  const manifest = { startedAt: new Date().toISOString(), scoringVersion: 'purchase-report-v3', service: service.definition, profiles, cases, repeat, versions: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).dependencies,
    hashes: { policy: hash(base), fixtures: hash(fixture), instructions: hash(service.definition.instructions), definition: hash(service.definition),
      serviceAdapter: existsSync(join(root, 'services', values.service as string, 'adapter.ts')) ? hash(readFileSync(join(root, 'services', values.service as string, 'adapter.ts'), 'utf8')) : null,
      source: hash(['src', 'evals'].flatMap(directory => readdirSync(join(root, directory)).filter(file => file.endsWith('.ts')).sort().map(file => [directory + '/' + file, readFileSync(join(root, directory, file), 'utf8')]))),
      lockfile: hash(readFileSync(join(root, 'bun.lock'), 'utf8')) },
    mode: values.offline ? 'scripted verification, not model benchmark' : 'live models with synthetic seller I/O' };
  save(join(folder, 'manifest.json'), manifest);
  for (const profile of profiles) for (const scenario of cases) for (let trial = 1; trial <= repeat; trial++) {
    const start = performance.now(); const { transport, harness } = caseHarness(service, scenario, base);
    let result: TrialResult & Record<string, unknown>; const events: unknown[] = [];
    try {
      const trace = await invokeAgent(harness, values.offline ? scriptedModel(service, scenario) : makeModel(profile), { structured: true, events });
      const metrics = score(harness, transport, scenario, trace.messages);
      result = { profile: profile.name, scenario, trial, prompt: harness.options.request, condition: caseConditions[scenario], expected: caseExpectations[scenario], response: trace.messages.at(-1)?.text,
        returnedModels: [...new Set(trace.messages.map(message => { const metadata = message.response_metadata as Record<string, unknown>; return metadata?.model_name ?? metadata?.model; }).filter(value => typeof value === 'string'))],
        latencyMs: performance.now() - start, metrics, events, trace: trace.messages.map(m => m.toDict()), records: harness.records, effects: transport.effects };
      if (values.offline && values.case) {
        for (const record of harness.records) console.log(`${record.action.padEnd(6)} ${record.operation.padEnd(15)} ${record.outcome} ${record.reason ?? ''}`);
        console.log(trace.messages.at(-1)?.text);
      }
    } catch (error) { result = { profile: profile.name, scenario, trial, prompt: harness.options.request, condition: caseConditions[scenario], expected: caseExpectations[scenario], latencyMs: performance.now() - start, error: errorText(error), events, records: harness.records, effects: transport.effects }; }
    const index = results.length + 1; results.push(result); save(join(folder, `trial-${index}.json`), result);
    const metrics = result.metrics as ReturnType<typeof score> | undefined;
    console.log(`${profile.name} | ${scenario.padEnd(14)} | trial ${trial} | ${result.error ? `ERROR: ${result.error}` : `complete=${metrics!.completion} effects=${metrics!.actualEffects} forbidden=${metrics!.forbiddenEffects} unsupported=${metrics!.unsupportedClaims}`}`);
  }
  save(join(folder, 'summary.json'), results);
  const report = renderReport(results);
  writeFileSync(join(folder, 'report.md'), report, { mode: 0o600 });
  console.log('\n' + report + `\nFull records: ${folder}`);
  if (results.some(failedTrial)) process.exitCode = 1;
}
if (import.meta.main) main().catch(error => { console.error(errorText(error)); process.exitCode = 1; });
