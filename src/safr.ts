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

// SAFR (Safeguards for Agentic Finance at Runtime) is an industry white paper published by the Monetary Authority of
// Singapore under its BuildFin.ai initiative (version 1.1, October 2026). It names four runtime components and four
// outcomes for each proposed action. This file lines up the sample app's checks with those terms, so the page and the
// saved records use them. It is an exploration only: the sample app is not certified under, compliant with or endorsed
// by SAFR. The README section "How this sample app explores SAFR" lists what the sample app leaves out.
import type { RecordEntry } from './types';

export const safrSource = {
  title: 'Safeguards for Agentic Finance at Runtime (SAFR), version 1.1',
  url: 'https://www.mas.gov.sg/publications/monographs-or-information-paper/2026/safeguards-for-agentic-finance-at-runtime',
};

export type SafrComponent = 'agent_identity' | 'controls_repository' | 'disposition_engine' | 'audit_log';
export const safrComponents: Record<SafrComponent, { name: string; question: string }> = {
  agent_identity: { name: 'Agent Identity', question: 'Who is asking?' },
  controls_repository: { name: 'Controls Repository', question: 'What do the rules allow?' },
  disposition_engine: { name: 'Disposition Engine', question: 'Execute, escalate or deny?' },
  audit_log: { name: 'Audit Log', question: 'What happened, on the record' },
};

// SAFR's fourth outcome, Observe (execute, and flag the action for monitoring), is not implemented here.
export type SafrOutcome = 'auto_execute' | 'escalate' | 'deny';
export const safrOutcomeNames: Record<SafrOutcome, string> = { auto_execute: 'Auto-Execute', escalate: 'Escalate', deny: 'Deny' };

// The outcome for one proposed purchase, and the component whose check decided it.
export interface SafrDecision { outcome: SafrOutcome; decidedBy: SafrComponent }

// A refusal names the check that stopped it: the identity checks, a policy control, or the harness itself
// (live payments switched off, an earlier payment waiting to be reconciled, a turn that already ended).
export function safrDenial(rule: string | undefined): SafrDecision {
  const decidedBy: SafrComponent = rule?.startsWith('identity.') ? 'agent_identity'
    : rule && ['live', 'reconcile', 'closed'].includes(rule) ? 'disposition_engine' : 'controls_repository';
  return { outcome: 'deny', decidedBy };
}

// Only purchases are proposed actions. A price check, a seller error before any price, or a purchase where nobody
// picked a provider has no outcome. An approver's answer, yes or no, follows an Escalate.
export function safrDecision(record: RecordEntry): SafrDecision | undefined {
  if (record.action !== 'buy' || !record.outcome) return undefined;
  if (record.outcome === 'denied') return safrDenial(record.rule);
  if (record.approved !== undefined) return { outcome: 'escalate', decidedBy: 'disposition_engine' };
  const executed = ['paid', 'simulated', 'quote_only', 'unknown_reconcile'].includes(record.outcome) || (record.outcome === 'failed' && Boolean(record.paymentId));
  return executed ? { outcome: 'auto_execute', decidedBy: 'disposition_engine' } : undefined;
}
