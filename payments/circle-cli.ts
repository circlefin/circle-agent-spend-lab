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

import { spawn } from 'node:child_process';

const maxOutputChars = 10 * 1024 * 1024;
// Node's own warnings, such as "(node:1234) [DEP0040] DeprecationWarning" and the "(Use `node --trace-deprecation ...`)" hint,
// which the CLI's dependencies print on stderr. They are dropped from error text so the real cause comes first.
const nodeWarning = /^\(node:\d+\)|^\(Use `node /;
const withoutNodeWarnings = (stderr: string): string => stderr.split('\n').filter(line => !nodeWarning.test(line.trimStart())).join('\n').trim();

export class CircleCliError extends Error {
  constructor(message: string, readonly args: readonly string[], readonly stdout: string, readonly stderr: string, readonly exitCode: number | null) {
    super(message); this.name = 'CircleCliError';
  }
}

// One circle process at a time: the agent can call tools in parallel, and two payments from one wallet must never overlap.
let queue: Promise<unknown> = Promise.resolve();
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task);
  queue = run.then(() => undefined, () => undefined); // A failed command must not reject the commands queued behind it.
  return run;
}

// No shell, so untrusted URLs and JSON bodies pass through verbatim. stdin is ignored, so a CLI prompt
// (a terms confirmation, say) sees end of input at once instead of waiting for input no agent can type.
function spawnCircle(args: readonly string[]): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn('circle', [...args], { timeout: 75_000, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', overflowed = false;
    const collect = (chunk: string, isError: boolean) => {
      if (isError) stderr += chunk; else stdout += chunk;
      if (!overflowed && stdout.length + stderr.length > maxOutputChars) { overflowed = true; child.kill(); }
    };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => collect(chunk, false));
    child.stderr.on('data', (chunk: string) => collect(chunk, true));
    child.on('error', reject);
    child.on('close', code => overflowed ? reject(new Error(`output exceeded ${maxOutputChars} characters`)) : resolve({ stdout, stderr, code }));
  });
}

// Runs the globally installed circle CLI with --output json and parses what it prints.
export async function runCircleJson<T>(args: readonly string[]): Promise<T> {
  const finalArgs = [...args, '--output', 'json'];
  let stdout = '', stderr = '', exitCode: number | null = null, detail = '';
  try {
    ({ stdout, stderr, code: exitCode } = await enqueue(() => spawnCircle(finalArgs)));
    if (exitCode !== 0) detail = withoutNodeWarnings(stderr) || stdout.trim() || `exited with code ${String(exitCode)}`;
    else try { return JSON.parse(stdout.trim()) as T; } catch (error) { detail = `unreadable JSON output: ${(error as Error).message}`; }
  } catch (error) { detail = error instanceof Error ? error.message : String(error); } // The process never ran, or its output ran over the cap.
  // The message names only the command; the full arguments, wallet address included, stay on the error object.
  throw new CircleCliError(`circle ${finalArgs.slice(0, 2).join(' ')} failed: ${detail}`, finalArgs, stdout, stderr, exitCode);
}
