import { z } from 'zod';
import type { NativeSessionConnection } from '@kilocode/cloud-agent-sdk';

const record = z.record(z.string(), z.unknown());

export const outcomeSchema = z.object({
  status: z.enum(['succeeded', 'failed', 'unknown']),
  result: z.unknown().optional(),
  error: z.object({ message: z.string() }).optional(),
});
export function commandResult(body: unknown): unknown {
  const outcome = outcomeSchema.parse(body);
  if (outcome.status === 'failed')
    throw new Error(outcome.error?.message ?? 'Runner command failed');
  if (outcome.status === 'unknown')
    throw new Error('Command outcome unknown. Refresh before retrying.');
  return outcome.result;
}

export function transcriptText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(transcriptText).join('\n');
  const value = record.safeParse(content);
  if (value.success && typeof value.data.text === 'string') return value.data.text;
  return JSON.stringify(content, null, 2) ?? '';
}

export type CommandOutcome = { error?: string; commandID?: string };
export type CommandRunner = (key: string, operation: () => Promise<string>) => Promise<boolean>;

/**
 * Runs one command per key at a time. A repeated press on the same control while
 * its command is in flight is ignored, and unrelated controls keep working.
 */
export function commandRunner(settle: (outcome: CommandOutcome) => void): CommandRunner {
  const running = new Set<string>();
  return async (key, operation) => {
    if (running.has(key)) return false;
    running.add(key);
    settle({ error: '' });
    try {
      settle({ commandID: await operation() });
      return true;
    } catch (cause) {
      settle({ error: cause instanceof Error ? cause.message : 'Command failed' });
      return false;
    } finally {
      running.delete(key);
    }
  };
}

export async function sendNativePrompt(
  connection: Pick<NativeSessionConnection, 'sendMessage' | 'sendCommand' | 'clear'>,
  text: string,
  queueIfOffline: boolean
) {
  const prompt = text.trim();
  if (prompt === '/clear') {
    connection.clear();
    return '';
  }
  if (!prompt.startsWith('/')) return connection.sendMessage(prompt, { queueIfOffline });
  const [command, ...args] = prompt.slice(1).split(/\s+/);
  if (!['compact', 'new', 'skill', 'models', 'agents'].includes(command)) {
    throw new Error('Use /compact, /new, /skill, /models, /agents or /clear (local only).');
  }
  return connection.sendCommand(command, args.join(' '));
}
