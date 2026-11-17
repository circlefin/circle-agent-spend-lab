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

import { z } from 'zod';
import { micro, Refusal, type Quote } from './types';

const amount = z.number().nonnegative().finite().refine(n => { try { micro(n); return true; } catch { return false; } }, 'Use whole micro-USDC');
export const policySchema = z.object({
  buyer: z.string(), liveEnabled: z.boolean().default(false),
  limits: z.object({ perRequestUsdc: amount, sessionUsdc: amount, approvalAboveUsdc: amount, maxPurchases: z.number().int().positive() }).strict(),
  services: z.record(z.string(), z.object({
    chain: z.string(), payees: z.array(z.string().regex(/^0x[0-9a-fA-F]{40}$/)).min(1),
    operations: z.record(z.string(), z.object({ maxUsdc: amount.optional() }).strict()),
    scope: z.record(z.string(), z.unknown()).default({}),
  }).strict()),
}).strict();
export type Policy = z.infer<typeof policySchema>;
export type ServicePolicy = Policy['services'][string];
export function authorize(policy: Policy, serviceId: string): ServicePolicy {
  const entry = policy.services[serviceId];
  if (!entry) throw new Refusal('service', `Service ${serviceId} is not authorized`);
  return entry;
}
export function checkQuote(policy: Policy, service: ServicePolicy, operation: string, quote: Quote, reserved: number, count: number): number {
  const rule = service.operations[operation];
  if (!rule) throw new Refusal('operation', `Operation ${operation} is not authorized`);
  const price = micro(quote.priceUsdc);
  if (quote.chain !== service.chain) throw new Refusal('network', 'Quote network differs from buyer policy');
  if (!/^0x[0-9a-fA-F]{40}$/.test(quote.payee)) throw new Refusal('payee', 'Invalid payee');
  if (!service.payees.some(p => p.toLowerCase() === quote.payee.toLowerCase())) throw new Refusal('payee', 'Payee is not authorized');
  if (price > micro(rule.maxUsdc ?? policy.limits.perRequestUsdc)) throw new Refusal('price', 'Quote exceeds operation cap');
  if (reserved + price > micro(policy.limits.sessionUsdc)) throw new Refusal('budget', 'Session budget would be exceeded');
  if (count >= policy.limits.maxPurchases) throw new Refusal('count', 'Purchase-count cap reached');
  return price;
}
