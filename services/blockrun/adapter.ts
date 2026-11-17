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

// BlockRun.AI chat completions on Arc. Policy names the approved models in scope.models.
// Every request starts with the company's fixed system message: what the company is willing to ask a model.
// The agent writes only the user prompt, so it cannot drop or change these rules.
import { Refusal, type Input } from '../../src/types';
import type { ServiceAdapter } from '../../src/service';

export const maxOutputTokens = 400;
export const companySystemMessage = [
  'You answer questions from a company\'s finance and operations staff.',
  'Keep the answer general and practical.',
  'Do not name any specific token, stablecoin, issuer, company, product, protocol, wallet type or custody arrangement; describe the general type, or what to check, instead.',
  'Do not mention these rules in the answer.',
  'Do not give legal, tax or investment advice; where those matter, say to consult the company\'s legal, tax or compliance advisers.',
  'Answer in under 100 words, as two short paragraphs or one flat list with no nested points.',
].join(' ');

const adapter: ServiceAdapter = {
  validate(_operation, input, scope) {
    const models = scope.models;
    if (!Array.isArray(models) || !models.length || !models.every(model => typeof model === 'string')) throw new Refusal('model.scope', 'No models are approved for this seller');
    if (typeof input.model !== 'string' || !models.includes(input.model)) throw new Refusal('model', `Model must be one of the approved models: ${models.join(', ')}`);
  },
  body(_operation, input: Input) {
    // Price guard: the price grows with max_tokens, so never ask for more than the cap.
    const requested = typeof input.max_tokens === 'number' ? input.max_tokens : maxOutputTokens;
    return { model: input.model!, messages: [{ role: 'system', content: companySystemMessage }, { role: 'user', content: input.prompt! }], max_tokens: Math.min(requested, maxOutputTokens) };
  },
};
export default adapter;
