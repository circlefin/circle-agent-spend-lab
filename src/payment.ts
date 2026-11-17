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

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Transport } from './types';

export interface PaymentOptions { chain: string; live: boolean }
export type PaymentFactory = (options: PaymentOptions) => Transport | Promise<Transport>;

export async function loadPayment(id: string, options: PaymentOptions, directory = resolve(import.meta.dir, '..', 'payments')): Promise<Transport> {
  if (!/^[a-z][a-z0-9_-]*$/.test(id)) throw new Error('Invalid local payment adapter ID');
  const path = join(directory, `${id}.ts`);
  if (!existsSync(path)) throw new Error(`Payment adapter ${id} is not installed. Add payments/${id}.ts.`);
  const factory = (await import(pathToFileURL(path).href)).default;
  if (typeof factory !== 'function') throw new Error(`Payment adapter ${id} must export a default factory`);
  const transport = await (factory as PaymentFactory)(options);
  if (!transport || !['quote', 'pay'].every(method => typeof transport[method as keyof Transport] === 'function'))
    throw new Error(`Payment adapter ${id} must provide quote and pay`);
  return transport;
}
