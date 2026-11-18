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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { args, root } from './cli';
import { companySchema, credentialSchema, exampleCompany, IdentitySession, signSession, type Binding } from './identity';
import { errorText } from './types';

export const localCompany = join(root, '.local');
export function loadIdentity(directory: string, employeeFile: string, agentFile: string, binding: Binding): IdentitySession {
  const readCompany = () => companySchema.parse(JSON.parse(readFileSync(join(directory, 'company.json'), 'utf8')));
  const employee = credentialSchema.parse(JSON.parse(readFileSync(employeeFile, 'utf8')));
  const agent = credentialSchema.parse(JSON.parse(readFileSync(agentFile, 'utf8')));
  const identity = new IdentitySession(signSession(readCompany().companyId, employee, agent, binding), readCompany);
  identity.check(binding); return identity;
}
// A fresh registry assigns the research agent to BlockRun.AI (blockrun).
export function initializeCompany(directory: string): void {
  if (existsSync(directory)) throw new Error('Company directory already exists. Keep its keys; choose another --directory for a fresh example.');
  const example = exampleCompany();
  mkdirSync(directory, { mode: 0o700 });
  for (const [name, value] of Object.entries({ 'company.json': example.company, 'employee.json': example.employee, 'observer.json': example.observer, 'agent.json': example.agent }))
    writeFileSync(join(directory, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
}
async function main() {
  const { values, positionals } = args({ directory: { type: 'string', default: localCompany } });
  if (values.help) { console.log('bun run company init [--directory PATH]\nCreates local example identity keys, not wallets. Existing directories are never overwritten.'); return; }
  if (positionals.length !== 1 || positionals[0] !== 'init') throw new Error('Use bun run company init');
  const directory = resolve(values.directory as string); initializeCompany(directory);
  console.log(`Created local ExampleCo identities in ${directory}\nanalyst: assigned to research-agent (seller: blockrun)\nobserver: registered, not assigned\nEdit company.json for assignments, approved sellers or revocation. Keep private-key files local.\nNo wallet was created or funded.`);
}
if (import.meta.main) main().catch(error => { console.error(errorText(error)); process.exitCode = 1; });
