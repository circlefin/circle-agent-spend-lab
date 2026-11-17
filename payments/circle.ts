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

// Circle CLI payment adapter: quotes with --estimate, pays over x402 with circle services pay. See README.md#credits.
import { z } from 'zod';
import { runCircleJson, CircleCliError } from './circle-cli';
import { BeforePaymentError, micro, type Transport, type Request } from '../src/types';
import type { PaymentOptions } from '../src/payment';

export default async function createTransport({ chain }: PaymentOptions): Promise<Transport> {
  const transport = circleTransport(process.env.CIRCLE_WALLET_ADDRESS ?? '', chain);
  await requireCircleSession(chain);
  return transport;
}

export function parseUsdc(value: string): number {
  if (!/^\$?\d+(?:\.\d{1,6})?(?: USDC)?$/.test(value)) throw new Error('Unrecognized CLI USDC amount');
  const amount = Number(value.replace(/^\$/, '').replace(/ USDC$/, '')); micro(amount); return amount;
}
export function receiptTx(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const raw = JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
    const tx = raw.transaction ?? raw.txHash;
    return typeof tx === 'string' && /^0x[0-9a-fA-F]{64}$/.test(tx) ? tx : undefined;
  } catch { return undefined; }
}
async function requireCircleSession(chain: string): Promise<void> {
  const raw = await runCircleJson<{ data?: Record<string, { tokenStatus?: string }> }>(['wallet', 'status', '--type', 'agent']);
  const environment = /TESTNET/.test(chain) ? 'testnet' : 'mainnet';
  if (raw.data?.[environment]?.tokenStatus?.toUpperCase() !== 'VALID') throw new Error(`A valid ${environment} Circle CLI session is required. Complete login and Terms acceptance outside this application.`);
}
// CLI errors that mean the payment was never sent, so the reservation can be released.
export const beforePayment = /exceeds --max-amount|invalid --max-amount|could not prepare required x402 extensions|seller does not accept --chain|could not sign payment authorization|insufficient .*balance|no gateway balance found|wallet not deployed/i;
export function circleTransport(address: string, chain: string): Transport {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error('CIRCLE_WALLET_ADDRESS must be an EVM address');
  const args = (req: Request) => ['services', 'pay', req.url, '-X', req.method, '--address', address, '--chain', chain, ...(req.body ? ['-d', req.body] : [])];
  return {
    async quote(req) {
      const raw = await runCircleJson<unknown>([...args(req), '--estimate', '--timeout', '30']);
      const parsed = z.object({ data: z.object({ price: z.string(), seller: z.string() }) }).parse(raw);
      return { priceUsdc: parseUsdc(parsed.data.price), payee: parsed.data.seller, chain };
    },
    async pay(req, ceiling, _localPaymentId) {
      // A local ledger ID is not seller idempotency. Never retry this command.
      let raw: unknown;
      try { raw = await runCircleJson<unknown>([...args(req), '--max-amount', String(ceiling), '--timeout', '60']); }
      catch (error) {
        // Only a failed exit counts: output that cannot be parsed after exit code 0 may follow a payment.
        const detail = error instanceof CircleCliError && error.exitCode !== 0 ? error.stderr.trim() || error.stdout.trim() : '';
        if (beforePayment.test(detail)) throw new BeforePaymentError(detail);
        throw error;
      }
      const parsed = z.object({ data: z.object({ response: z.unknown(), payment: z.object({ amount: z.string().optional(), seller: z.string().optional(), receipt: z.unknown().optional() }).optional() }) }).parse(raw);
      return { output: parsed.data.response, seller: parsed.data.payment?.seller,
        amountUsdc: parsed.data.payment?.amount ? parseUsdc(parsed.data.payment.amount) : undefined, tx: receiptTx(parsed.data.payment?.receipt) };
    },
  };
}
