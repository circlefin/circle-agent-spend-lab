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

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign, verify } from 'node:crypto';
import { z } from 'zod';
import { Refusal } from './types';

const id = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
export const companySchema = z.object({
  companyId: id,
  employees: z.record(id, z.object({ publicKey: z.string(), active: z.boolean() }).strict()),
  agents: z.record(id, z.object({ publicKey: z.string(), active: z.boolean(), employees: z.array(id), services: z.array(z.string().regex(/^[a-z][a-z0-9_-]*$/)) }).strict()),
}).strict();
export type Company = z.infer<typeof companySchema>;
export const credentialSchema = z.object({ id, privateKey: z.string() }).strict();
export type Credential = z.infer<typeof credentialSchema>;
const sessionSchema = z.object({
  companyId: id, employeeId: id, agentId: id, sessionId: z.uuid(),
  requestHash: z.string(), serviceHash: z.string(), policyHash: z.string(),
  issuedAt: z.number().int(), expiresAt: z.number().int(),
}).strict();
export type IdentitySummary = z.infer<typeof sessionSchema>;
export interface Binding { request: string; service: unknown; policy: unknown }
export interface SignedSession { context: IdentitySummary; employeeSignature: string; agentSignature: string }
const ttlMs = 5 * 60_000;
const admitted = new Set<string>(); // Replay protection is process-local, just like the budget.

const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bytes = (context: IdentitySummary) => Buffer.from(JSON.stringify(sessionSchema.parse(context)));
function signature(privateKey: string, context: IdentitySummary): string {
  const key = createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Identity keys must use Ed25519');
  return sign(null, bytes(context), key).toString('base64');
}
export function signSession(companyId: string, employee: Credential, agent: Credential, binding: Binding, now = Date.now()): SignedSession {
  const context = sessionSchema.parse({ companyId, employeeId: employee.id, agentId: agent.id, sessionId: randomUUID(),
    requestHash: digest(binding.request), serviceHash: digest(binding.service), policyHash: digest(binding.policy), issuedAt: now, expiresAt: now + ttlMs });
  return { context, employeeSignature: signature(employee.privateKey, context), agentSignature: signature(agent.privateKey, context) };
}
function validSignature(publicKey: string, context: IdentitySummary, encoded: string): boolean {
  try {
    const key = createPublicKey(publicKey); const data = Buffer.from(encoded, 'base64');
    return key.asymmetricKeyType === 'ed25519' && data.length === 64 && data.toString('base64') === encoded && verify(null, bytes(context), key, data);
  } catch { return false; }
}

// The caller supplies a company-controlled registry. Never resolve trust from model input.
export class IdentitySession {
  private readonly proof: SignedSession;
  constructor(proof: SignedSession, private readonly readCompany: () => Company) { this.proof = structuredClone(proof); }
  check(binding: Binding, now = Date.now()): IdentitySummary {
    const parsed = sessionSchema.safeParse(this.proof.context);
    if (!parsed.success) throw new Refusal('identity.proof', 'Malformed identity context');
    const context = parsed.data; let company: Company;
    try { company = companySchema.parse(this.readCompany()); }
    catch { throw new Refusal('identity.registry', 'Company registry is unavailable or invalid; check local administration'); }
    if (context.companyId !== company.companyId) throw new Refusal('identity.company', 'Session belongs to another company');
    if (context.issuedAt > now + 5000 || context.expiresAt <= now || context.expiresAt <= context.issuedAt || context.expiresAt - context.issuedAt > ttlMs)
      throw new Refusal('identity.expired', 'Identity session expired or has invalid timing; start a new session');
    if (context.requestHash !== digest(binding.request) || context.serviceHash !== digest(binding.service) || context.policyHash !== digest(binding.policy))
      throw new Refusal('identity.context', 'Request, service or policy changed after signing; start a new session');
    const employee = Object.hasOwn(company.employees, context.employeeId) ? company.employees[context.employeeId] : undefined;
    const agent = Object.hasOwn(company.agents, context.agentId) ? company.agents[context.agentId] : undefined;
    if (!employee?.active) throw new Refusal('identity.employee', 'Employee is unknown or inactive');
    if (!agent?.active) throw new Refusal('identity.agent', 'Agent is unknown or revoked');
    if (!validSignature(employee.publicKey, context, this.proof.employeeSignature) || !validSignature(agent.publicKey, context, this.proof.agentSignature))
      throw new Refusal('identity.proof', 'Employee or agent signature does not match the company registry');
    if (!agent.employees.includes(context.employeeId)) throw new Refusal('identity.assignment', 'Employee is not assigned to this agent');
    const serviceId = (binding.service as { id?: string }).id;
    if (!serviceId || !agent.services.includes(serviceId)) throw new Refusal('identity.service', 'Agent is not assigned to this service');
    return context;
  }
  admit(binding: Binding): IdentitySummary {
    const context = this.check(binding);
    const key = `${context.companyId}/${context.sessionId}`;
    if (admitted.has(key)) throw new Refusal('identity.replay', 'Identity session was already used; sign a fresh task');
    admitted.add(key); return context;
  }
}

export function newCredential(name: string): { credential: Credential; publicKey: string } {
  const pair = generateKeyPairSync('ed25519');
  return { credential: { id: id.parse(name), privateKey: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() },
    publicKey: pair.publicKey.export({ format: 'pem', type: 'spki' }).toString() };
}
export function exampleCompany(services: string[] = ['blockrun']) {
  const analyst = newCredential('analyst'); const observer = newCredential('observer'); const agent = newCredential('research-agent');
  const company: Company = { companyId: 'example-co', employees: {
    analyst: { publicKey: analyst.publicKey, active: true }, observer: { publicKey: observer.publicKey, active: true },
  }, agents: { 'research-agent': { publicKey: agent.publicKey, active: true, employees: ['analyst'], services } } };
  return { company, employee: analyst.credential, observer: observer.credential, agent: agent.credential };
}
