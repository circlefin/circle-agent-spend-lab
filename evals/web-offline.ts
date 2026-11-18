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

// The web chat with no keys, wallet or payment: bun run web:offline. The page, harness, policy checks, signed identities,
// provider picker and SAFR panel are the real ones. The agent is scripted (it proposes one purchase per question), the
// seller is the scripted BlockRun.AI fixture, and payments are simulated. Every question gets the fixture's recorded answer.
import { join } from 'node:path';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { ChatResult } from '@langchain/core/outputs';
import { readPolicy, root } from '../src/cli';
import { exampleCompany, IdentitySession, signSession } from '../src/identity';
import { loadService, type Service } from '../src/service';
import { optionLabels } from '../src/web-events';
import type { ActAs, WebChatOptions } from '../src/web';
import { FixtureTransport } from './fixtures';

const text = (message: BaseMessage | undefined): string => typeof message?.content === 'string' ? message.content : '';

// Proposes one purchase for each question, then sums up the tool result in a sentence. It never sees keys or the wallet.
export class OfflineAgentModel extends BaseChatModel {
  constructor(readonly service: Service, readonly operation: string) { super({}); }
  _llmType(): string { return 'offline-web'; }
  bindTools(): this { return this; }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const last = messages.at(-1);
    const message = ToolMessage.isInstance(last) ? new AIMessage(this.summary(text(last))) : new AIMessage({ content: '', tool_calls: [{
      name: 'buy', id: crypto.randomUUID(), type: 'tool_call',
      args: { operation: this.operation, input: { prompt: text([...messages].reverse().find(entry => HumanMessage.isInstance(entry))) }, purpose: "Answer the employee's question" },
    }] });
    return { generations: [{ message, text: text(message) }] };
  }
  private summary(result: string): string {
    let outcome: { outcome?: string; message?: string; costUsdc?: number | null; data?: { model?: string } | null } = {};
    try { outcome = JSON.parse(result); } catch { /* Not JSON: say nothing was bought. */ }
    if (outcome.outcome === 'simulated' || outcome.outcome === 'paid') {
      const names = optionLabels(this.service)[outcome.data?.model ?? ''];
      return `${names ? `${names.label} from ${names.provider}` : 'The model'} answered, for a simulated ${outcome.costUsdc ?? 0} USDC. `
        + 'This is the offline demo, so the answer is a recorded one for the sample question and nothing was paid.';
    }
    return `Nothing was bought. ${outcome.message ?? ''}`.trim();
  }
}

// Everything createWebChat needs apart from the bridges and the record folder.
export async function offlineWebChat(): Promise<Omit<WebChatOptions, 'bridge' | 'choices' | 'directory'>> {
  const service = await loadService('blockrun');
  const policy = readPolicy(join(root, 'policy.json'));
  policy.liveEnabled = true; // In memory only: the fixture transport simulates every payment.
  const example = exampleCompany([service.definition.id]);
  return {
    policy, live: true, offline: true, sellers: [service.definition.id], catalog: new Map([[service.definition.id, service]]),
    model: new OfflineAgentModel(service, 'chat_completion'),
    company: 'ExampleCo', employeeId: example.employee.id, agentId: example.agent.id, observerId: example.observer.id,
    transport: async () => new FixtureTransport(service, 'answer'),
    identity: (actAs: ActAs, binding) => {
      const session = new IdentitySession(signSession(example.company.companyId, actAs === 'observer' ? example.observer : example.employee, example.agent, binding), () => example.company);
      session.check(binding); return session;
    },
  };
}
