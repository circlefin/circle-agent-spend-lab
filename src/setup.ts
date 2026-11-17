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

// Setup shared by the terminal chat (src/chat.ts) and the local web chat (src/web.ts).
// Sellers come from policy: a seller is offered only when policy.json approves it and the company
// registry assigns it to the agent. The session budget and purchase cap apply to the whole chat.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { loadService, type Service } from './service';
import type { Policy } from './policy';
import { loadPayment } from './payment';
import { readPolicy, root } from './cli';
import { makeModel, modelProfileSchema, type ModelProfile } from './agent';
import { companySchema, credentialSchema, type Company } from './identity';
import { micro, type Transport } from './types';

export interface Turn { question: string; answer: string }
const contextTurns = 3, contextChars = 1500;

// Earlier turns travel inside the signed request, so the employee signs the context too.
export function withContext(history: Turn[], question: string): string {
  if (!history.length) return question;
  const earlier = history.slice(-contextTurns).map(turn => `Analyst: ${turn.question}\nAgent: ${turn.answer.slice(0, contextChars)}`).join('\n\n');
  return `Earlier in this chat, for context only:\n\n${earlier}\n\nCurrent request: ${question}`;
}

// The remaining chat allowance, expressed as the policy the next question is signed against.
export function remainingPolicy(policy: Policy, reservedMicro: number, purchases: number): Policy {
  const leftMicro = Math.max(0, micro(policy.limits.sessionUsdc) - reservedMicro);
  const leftPurchases = policy.limits.maxPurchases - purchases;
  return { ...policy, limits: { ...policy.limits, sessionUsdc: leftMicro / 1e6, maxPurchases: Math.max(0, leftPurchases) } };
}

// Sellers approved in policy and assigned to this agent in the company registry.
export function approvedSellers(policy: Policy, company: Company, agentId: string): string[] {
  const agent = Object.hasOwn(company.agents, agentId) ? company.agents[agentId] : undefined;
  if (!agent?.active) return [];
  return Object.keys(policy.services).filter(id => agent.services.includes(id) && existsSync(join(root, 'services', id, 'service.json')));
}

export interface ChatSetup {
  companyDirectory: string; employeeFile: string; agentFile: string; employeeId: string; agentId: string;
  company: Company; policy: Policy; live: boolean; sellers: string[]; catalog: Map<string, Service>;
  profile: ModelProfile; model: BaseChatModel;
  // One payment adapter per chain, loaded on first use.
  transport(chain: string): Promise<Transport>;
}

export async function chatSetup(values: Record<string, string | boolean | undefined>): Promise<ChatSetup> {
  if (!values.payment) throw new Error('--payment is required. Select a local adapter from payments/.');
  if (!process.env.OPENAI_API_KEY || !process.env.OPENAI_MODEL)
    throw new Error('No model configured. Copy .env.example to .env, then set OPENAI_API_KEY and OPENAI_MODEL (and OPENAI_BASE_URL for a gateway).');
  const companyDirectory = values.company as string;
  if (!existsSync(join(companyDirectory, 'company.json'))) throw new Error('No company registry. Run bun run company init first.');
  const employeeFile = values.employee as string || join(companyDirectory, 'employee.json');
  const agentFile = values['agent-key'] as string || join(companyDirectory, 'agent.json');
  const employeeId = credentialSchema.parse(JSON.parse(readFileSync(employeeFile, 'utf8'))).id;
  const agentId = credentialSchema.parse(JSON.parse(readFileSync(agentFile, 'utf8'))).id;
  const company = companySchema.parse(JSON.parse(readFileSync(join(companyDirectory, 'company.json'), 'utf8')));

  const policy = readPolicy(values.policy as string);
  const live = Boolean(values.live);
  if (live && !policy.liveEnabled) throw new Error('policy.liveEnabled is false');
  const sellers = approvedSellers(policy, company, agentId);
  if (!sellers.length) throw new Error(`No seller is both approved in policy.json and assigned to ${agentId} in the company registry.`);
  const requested = values.service as string | undefined;
  if (requested && !sellers.includes(requested)) throw new Error(`${requested} is not approved for ${agentId}. Approved: ${sellers.join(', ')}`);
  const catalog = new Map<string, Service>();
  for (const id of sellers) catalog.set(id, await loadService(id));

  const profile = modelProfileSchema.parse({ name: 'chat', model: process.env.OPENAI_MODEL, apiMode: process.env.OPENAI_API_MODE ?? 'responses', apiKeyEnv: 'OPENAI_API_KEY', ...(process.env.OPENAI_BASE_URL ? { baseUrlEnv: 'OPENAI_BASE_URL' } : {}) });
  const model = makeModel(profile);
  const transports = new Map<string, Transport>();
  const transport = async (chain: string) => {
    if (!transports.has(chain)) transports.set(chain, await loadPayment(values.payment as string, { chain, live }));
    return transports.get(chain)!;
  };
  return { companyDirectory, employeeFile, agentFile, employeeId, agentId, company, policy, live, sellers, catalog, profile, model, transport };
}
