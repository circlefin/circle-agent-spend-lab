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

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { policySchema } from './policy';

export const root = resolve(import.meta.dir, '..');
export function args(extra: Record<string, { type: 'boolean' | 'string'; default?: string | boolean }> = {}): { values: Record<string, string | boolean | undefined>; positionals: string[] } {
  return parseArgs({ args: process.argv.slice(2), allowPositionals: true, strict: true, options: {
    service: { type: 'string' }, policy: { type: 'string', default: join(root, 'policy.json') }, help: { type: 'boolean' }, ...extra,
  } });
}
export function readPolicy(path: string) { return policySchema.parse(JSON.parse(readFileSync(path, 'utf8'))); }
export function outputFolder(kind: string, parent = join(root, 'runs')): string {
  const path = join(parent, `${kind}-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}`);
  mkdirSync(path, { recursive: true, mode: 0o700 }); return path;
}
export function save(path: string, value: unknown) { writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); }
