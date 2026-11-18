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

import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { authorize, checkQuote, type Policy, type ServicePolicy } from './policy';
import { prepare, type Service } from './service';
import { IdentitySession, type IdentitySummary } from './identity';
import { safrDecision, safrDenial } from './safr';
import { BeforePaymentError, Refusal, errorText, micro, type Input, type Quote, type RecordEntry, type Transport } from './types';

// Structured approval details for screens that show an approval card. The text description stays for the terminal.
export interface ApprovalDetails { recordId: string; operation: string; priceUsdc: number; chain: string; payee: string; purpose: string; input: Input }

// An operation can declare in its metadata that a person chooses one input field, such as the model, from a list
// that policy approves: { "choice": { "field": "model", "scope": "models" } } reads policy scope.models.
// With a choose callback, every option is checked and quoted first; the purchase then runs the usual checks on the pick.
export interface ChoiceOption { value: string; quote?: Quote; refused?: { rule: string; reason: string } }
export interface ChoiceDetails { recordId: string; operation: string; field: string; purpose: string; input: Input; options: ChoiceOption[] }
function choiceOf(service: Service, operation: string, scope: Record<string, unknown>): { field: string; values: string[] } | undefined {
  const declared = service.definition.operations[operation]?.metadata?.choice as { field?: unknown; scope?: unknown } | undefined;
  if (!declared) return undefined;
  if (typeof declared.field !== 'string' || typeof declared.scope !== 'string') throw new Error(`Choice metadata for ${operation} needs field and scope`);
  const values = scope[declared.scope];
  if (!Array.isArray(values) || !values.length || !values.every(value => typeof value === 'string')) throw new Refusal('choice.scope', 'Policy approves no options to choose from');
  return { field: declared.field, values: values as string[] };
}

// A request refused before any harness exists, such as an identity failure or live payments switched off, is still a
// decision on the record. The web chat, bun run chat and bun run agent all write it to the same journal.
export function logRefusalBeforeRun(journal: string, rule: string, reason: string, at = new Date().toISOString()): void {
  mkdirSync(dirname(journal), { recursive: true });
  appendFileSync(journal, JSON.stringify({ stage: 'refused_before_run', at, outcome: 'denied', rule, reason, safr: safrDenial(rule) }) + '\n', { mode: 0o600 });
}

export class Harness {
  readonly records: RecordEntry[] = [];
  reservedMicro = 0; purchaseCount = 0; halted?: string; private closed = false;
  private queue: Promise<unknown> = Promise.resolve();
  private inFlight = new Set<RecordEntry>();
  readonly authority: ServicePolicy;
  readonly actor: IdentitySummary;
  constructor(readonly options: { service: Service; policy: Policy; transport: Transport; live?: boolean; request: string;
    identity: IdentitySession; approve?: (description: string, details: ApprovalDetails) => Promise<boolean>;
    choose?: (details: ChoiceDetails) => Promise<string | undefined>; journal?: string }) {
    this.authority = authorize(options.policy, options.service.definition.id);
    if (options.live && !options.policy.liveEnabled) throw new Refusal('live', 'Policy liveEnabled is false');
    for (const id of Object.keys(this.authority.operations)) if (!options.service.definition.operations[id]) throw new Error(`Policy authorizes unknown operation ${id}`);
    if (!(options.identity instanceof IdentitySession)) throw new Refusal('identity.proof', 'A verified identity session is required');
    this.actor = options.identity.admit(this.binding());
  }
  private binding() { return { request: this.options.request, service: this.options.service.definition, policy: this.options.policy }; }
  checkIdentity(): void { this.options.identity.check(this.binding()); }
  cancel(): void {
    this.closed = true;
    for (const record of this.inFlight) {
      record.outcome = 'unknown_reconcile'; record.reason = 'Run ended while payment was in flight'; record.safr = safrDecision(record);
      this.halted = `Payment ${record.paymentId} was interrupted; reconcile before restarting`;
      try { this.log(record, 'interrupted_payment'); } catch { record.reason += '; interruption record could not be written'; }
    }
  }
  private active(): void {
    if (this.closed) throw new Refusal('closed', 'Run has ended');
    if (this.halted) throw new Refusal('reconcile', this.halted);
    this.checkIdentity();
  }
  private log(rec: RecordEntry, stage: string): void {
    if (this.options.journal) {
      mkdirSync(dirname(this.options.journal), { recursive: true });
      appendFileSync(this.options.journal, JSON.stringify({ stage, ...rec }) + '\n', { mode: 0o600 });
    }
  }
  // Returns the input with the person's choice filled in. No choice declared: the input as given.
  private async choose(rec: RecordEntry, operation: string, input: unknown, purpose: string): Promise<unknown> {
    const { service, transport, policy } = this.options; const scope = this.authority.scope;
    const choice = choiceOf(service, operation, scope);
    if (!choice) return input;
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Refusal('input', 'Input must be an object');
    if (!purpose.trim()) throw new Refusal('purpose', 'A purchase needs a recorded purpose');
    const withValue = (value: string) => ({ ...(input as Input), [choice.field]: value });
    prepare(service, operation, withValue(choice.values[0]!), scope); // A malformed request is refused before any quote.
    const options = await Promise.all(choice.values.map(async (value): Promise<ChoiceOption> => {
      let quote: Quote | undefined;
      try {
        quote = await transport.quote(prepare(service, operation, withValue(value), scope).request);
        checkQuote(policy, this.authority, operation, quote, this.reservedMicro, this.purchaseCount);
        return { value, quote };
      } catch (error) {
        return { value, ...(quote ? { quote } : {}), refused: { rule: error instanceof Refusal ? error.rule : 'execution', reason: errorText(error) } };
      }
    }));
    this.active();
    const picked = await this.options.choose!({ recordId: rec.id, operation, field: choice.field, purpose, input: structuredClone(input as Input), options });
    if (!picked || !options.some(option => option.value === picked && option.quote && !option.refused)) {
      rec.outcome = 'approval_denied'; throw new Refusal('choice', 'No option was chosen, so nothing was bought');
    }
    rec.chosen = picked; rec.input = withValue(picked);
    return withValue(picked);
  }
  async call(action: 'quote' | 'buy', operation: string, input: unknown, purpose = ''): Promise<Record<string, unknown>> {
    const rec: RecordEntry = { id: randomUUID(), at: new Date().toISOString(), action, operation, input: structuredClone(input), purpose, identity: { ...this.actor } };
    this.records.push(rec);
    try {
      this.active();
      if (!this.authority.operations[operation]) throw new Refusal('operation', `Operation ${operation} is not authorized`);
      const raw = action === 'buy' && this.options.choose ? await this.choose(rec, operation, input, purpose) : input;
      const prepared = prepare(this.options.service, operation, raw, this.authority.scope);
      const quote = await this.options.transport.quote(prepared.request);
      rec.quote = quote;
      this.active();
      // No await between the spend check and reservation, including concurrent tool calls.
      const price = checkQuote(this.options.policy, this.authority, operation, quote, this.reservedMicro, this.purchaseCount);
      if (action === 'quote') { rec.outcome = 'quoted'; return { outcome: 'quoted', quote, source: prepared.request.url }; }
      if (!purpose.trim()) throw new Refusal('purpose', 'A purchase needs a recorded purpose');
      this.reservedMicro += price; this.purchaseCount += 1;
      rec.paymentId = randomUUID();
      try {
        if (price > micro(this.options.policy.limits.approvalAboveUsdc)) {
          const details: ApprovalDetails = { recordId: rec.id, operation, priceUsdc: quote.priceUsdc, chain: quote.chain, payee: quote.payee, purpose, input: structuredClone(prepared.input) };
          rec.approved = await (this.options.approve?.(`Approve ${quote.priceUsdc} USDC for ${operation} on ${quote.chain} to ${quote.payee}? Purpose: ${purpose}\nInputs: ${JSON.stringify(prepared.input)}`, details) ?? Promise.resolve(false));
          if (!rec.approved) { rec.outcome = 'approval_denied'; throw new Refusal('approval', 'Approver declined'); }
        }
        this.active();
        if (!this.options.live) { rec.outcome = 'quote_only'; return { outcome: 'quote_only', quote, data: null, message: 'Quote only: nothing was paid and the seller returned nothing. The reservation is kept for the rehearsal.' }; }
        // The queued callback rechecks halt state after earlier payment outcomes are known.
        const execute = this.queue.then(async () => {
          this.active(); this.log(rec, 'before_payment');
          this.inFlight.add(rec);
          try {
            const result = await this.options.transport.pay(prepared.request, quote.priceUsdc, rec.paymentId!);
            rec.payment = result; rec.outcome = result.simulated ? 'simulated' : 'paid';
            if (result.amountUsdc !== undefined && micro(result.amountUsdc) > price) this.halted = 'Reported payment exceeds approved ceiling; reconcile before continuing';
            if (result.seller && result.seller.toLowerCase() !== quote.payee.toLowerCase()) this.halted = 'Reported recipient differs from approval; reconcile before continuing';
            return { outcome: rec.outcome, data: result.output, source: prepared.request.url, costUsdc: result.amountUsdc ?? null, reservedUsdc: quote.priceUsdc, receipt: result.tx ?? null, halted: this.halted ?? null };
          } catch (error) {
            if (error instanceof BeforePaymentError) { rec.outcome = 'failed'; throw error; }
            rec.outcome = 'unknown_reconcile'; this.halted = `Payment ${rec.paymentId} needs reconciliation. No automatic retry.`;
            rec.reason = errorText(error);
            return { outcome: rec.outcome, message: this.halted, data: null };
          } finally { this.inFlight.delete(rec); }
        });
        this.queue = execute.catch(() => undefined);
        return await execute;
      } finally {
        if (!['paid', 'simulated', 'quote_only', 'unknown_reconcile'].includes(rec.outcome ?? '')) { this.reservedMicro -= price; this.purchaseCount -= 1; }
      }
    } catch (error) {
      rec.outcome ??= error instanceof Refusal ? 'denied' : 'failed';
      rec.rule = error instanceof Refusal ? error.rule : 'execution'; rec.reason = errorText(error);
      return { outcome: rec.outcome, rule: rec.rule, message: rec.reason, data: null };
    } finally {
      rec.safr = safrDecision(rec);
      try { this.log(rec, 'complete'); } catch (error) { this.halted = `Record write failed: ${errorText(error)}`; throw error; }
    }
  }
}
