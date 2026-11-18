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

import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { Refusal, type Input, type Json, type Request } from './types';

const operationSchema = z.object({
  description: z.string(), method: z.enum(['GET', 'POST']), path: z.string().startsWith('/'),
  inputSchema: z.record(z.string(), z.unknown()), metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();
const definitionSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]*$/), name: z.string(), baseUrl: z.url(),
  operations: z.record(z.string().regex(/^[a-z][a-z0-9_]*$/), operationSchema),
  metadata: z.record(z.string(), z.unknown()).optional(), instructions: z.string().default(''),
}).strict();
export type ServiceDefinition = z.infer<typeof definitionSchema>;
export interface ServiceAdapter {
  validate?(operation: string, input: Input, scope: Record<string, unknown>): void;
  body?(operation: string, input: Input): Json;
}
export interface Service {
  definition: ServiceDefinition;
  adapter: ServiceAdapter; validators: Map<string, z.ZodType>;
}
const supported = new Set(['$schema', 'type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'description', 'title', 'minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'minItems', 'maxItems']);
function checkSchema(schema: Record<string, unknown>): void {
  for (const key of Object.keys(schema)) if (!supported.has(key)) throw new Error(`Unsupported input schema keyword: ${key}`);
  if (schema.type === 'object') {
    if (schema.additionalProperties !== false) throw new Error('Object schemas must set additionalProperties: false');
    for (const child of Object.values(schema.properties ?? {})) checkSchema(child as Record<string, unknown>);
  }
  if (schema.items) checkSchema(schema.items as Record<string, unknown>);
}
export function parseDefinition(raw: unknown): { definition: ServiceDefinition; validators: Map<string, z.ZodType> } {
  const definition = definitionSchema.parse(raw);
  const base = new URL(definition.baseUrl);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new Error('baseUrl must be an HTTPS origin');
  const validators = new Map<string, z.ZodType>();
  if (!Object.keys(definition.operations).length) throw new Error('Service needs at least one operation');
  for (const [id, operation] of Object.entries(definition.operations)) {
    if (!/^\/[A-Za-z0-9_/.-]*$/.test(operation.path) || operation.path.includes('..') || operation.path.includes('//')) throw new Error(`Unsafe operation path: ${id}`);
    if (operation.inputSchema.type !== 'object') throw new Error('Operation inputs must be objects');
    checkSchema(operation.inputSchema);
    validators.set(id, z.fromJSONSchema(operation.inputSchema as Parameters<typeof z.fromJSONSchema>[0]));
  }
  return { definition, validators };
}
export async function loadService(id: string, root = resolve(import.meta.dir, '..', 'services')): Promise<Service> {
  if (!/^(?:[a-z][a-z0-9_-]*|_template)$/.test(id)) throw new Error('Invalid local service ID');
  const folder = join(root, id);
  const parsed = parseDefinition(JSON.parse(readFileSync(join(folder, 'service.json'), 'utf8')));
  if (parsed.definition.id !== (id === '_template' ? 'example' : id)) throw new Error('Folder and service ID differ');
  const adapter = existsSync(join(folder, 'adapter.ts')) ? (await import(pathToFileURL(join(folder, 'adapter.ts')).href)).default as ServiceAdapter : {};
  return { ...parsed, adapter };
}
export function prepare(service: Service, operation: string, raw: unknown, scope: Record<string, unknown>): { request: Request; input: Input } {
  const op = service.definition.operations[operation];
  if (!op) throw new Refusal('operation', `Unknown operation: ${operation}`);
  const parsed = service.validators.get(operation)!.safeParse(raw);
  if (!parsed.success) throw new Refusal('input', parsed.error.message);
  const input = parsed.data as Input;
  service.adapter.validate?.(operation, input, scope);
  const url = new URL(op.path, service.definition.baseUrl);
  // Defence in depth: parseDefinition already refuses paths that could leave the origin.
  if (url.origin !== new URL(service.definition.baseUrl).origin) throw new Refusal('origin', 'Unexpected service origin');
  if (op.method === 'GET') for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'object') throw new Refusal('input', 'GET query values must be scalar');
    url.searchParams.set(key, String(value));
  }
  return { input, request: { operation, url: url.href, method: op.method,
    ...(op.method === 'POST' ? { body: JSON.stringify(service.adapter.body?.(operation, input) ?? input) } : {}) } };
}
