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

import type { IdentitySummary } from './identity';
import type { SafrDecision } from './safr';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Input = Record<string, Json>;
export interface Request { operation: string; url: string; method: 'GET' | 'POST'; body?: string }
export interface Quote { priceUsdc: number; payee: string; chain: string }
export interface Payment { output: unknown; amountUsdc?: number; seller?: string; tx?: string; simulated?: boolean }
export interface Transport {
  quote(request: Request): Promise<Quote>;
  pay(request: Request, ceilingUsdc: number, paymentId: string): Promise<Payment>;
}
export type Outcome = 'quoted' | 'quote_only' | 'simulated' | 'paid' | 'denied' | 'approval_denied' | 'unknown_reconcile' | 'failed';
export interface RecordEntry {
  id: string; at: string; action: string; operation: string; input: unknown; purpose?: string;
  outcome?: Outcome; rule?: string; reason?: string; quote?: Quote; payment?: Payment;
  paymentId?: string; approved?: boolean; chosen?: string; identity?: IdentitySummary;
  safr?: SafrDecision; // The SAFR outcome, set when the record is final (src/safr.ts).
}
export class BeforePaymentError extends Error {}
export class Refusal extends Error { constructor(readonly rule: string, message: string) { super(message); } }
export const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
export function micro(amount: number): number {
  if (!Number.isFinite(amount) || amount < 0 || !Number.isSafeInteger(Math.round(amount * 1e6)) || Math.abs(amount * 1e6 - Math.round(amount * 1e6)) > 1e-6)
    throw new Refusal('price', 'USDC must be a finite nonnegative amount with at most six decimal places');
  return Math.round(amount * 1e6);
}
