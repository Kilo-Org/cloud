import type { StoredMessage } from '@kilocode/cloud-agent-sdk';

export type SessionTokenUsage = {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
};

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
