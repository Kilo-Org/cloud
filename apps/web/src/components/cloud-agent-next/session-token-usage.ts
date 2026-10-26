import type { StoredMessage } from '@kilocode/cloud-agent-sdk';
import { getSessionCostBreakdown } from './session-cost-breakdown';

export type SessionTokenUsage = {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
};

export type SessionModelUsage = {
  providerID: string;
  modelID: string;
  costUsd: number;
  tokens: SessionTokenUsage;
};

export type SessionUsage = {
  tokens: SessionTokenUsage;
  models: SessionModelUsage[];
};

export function getSessionUsage(messages: ReadonlyArray<StoredMessage>): SessionUsage {
  const groups = new Map<
    string,
    { providerID: string; modelID: string; messages: StoredMessage[] }
  >();
  for (const message of messages) {
    if (message.info.role !== 'assistant') continue;
    const { providerID, modelID } = message.info;
    const key = JSON.stringify([providerID, modelID]);
    const group = groups.get(key);
    if (group) {
      group.messages.push(message);
    } else {
      groups.set(key, { providerID, modelID, messages: [message] });
    }
  }

  return {
    tokens: getSessionTokenUsage(messages),
    models: [...groups.values()].map(({ providerID, modelID, messages }) => ({
      providerID,
      modelID,
      costUsd: getSessionCostBreakdown(messages, null, 0).rootCostUsd,
      tokens: getSessionTokenUsage(messages),
    })),
  };
}

export function getSessionTokenUsage(messages: ReadonlyArray<StoredMessage>): SessionTokenUsage {
  const usage: SessionTokenUsage = {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
  };
  const validCount = (count: number) => (Number.isFinite(count) && count > 0 ? count : 0);

  for (const message of messages) {
    if (message.info.role !== 'assistant') continue;

    const steps = message.parts.filter(part => part.type === 'step-finish');
    // Message tokens describe the latest step, not the sum of every request.
    const reports = steps.length > 0 ? steps : [message.info];
    for (const { tokens } of reports) {
      usage.input += validCount(tokens.input);
      usage.output += validCount(tokens.output);
      usage.reasoning += validCount(tokens.reasoning);
      usage.cacheRead += validCount(tokens.cache.read);
      usage.cacheWrite += validCount(tokens.cache.write);
    }
  }

  return usage;
}
