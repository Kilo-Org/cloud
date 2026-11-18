import { type NativeSessionConnection } from '@kilocode/cloud-agent-sdk';
import { z } from 'zod';
import { i18n } from '@/i18n';

const record = z.record(z.string(), z.unknown());
const stringSchema = z.string();

const outcomeSchema = z.object({
  status: z.enum(['succeeded', 'failed', 'unknown']),
  result: z.unknown().optional(),
  error: z.object({ message: z.string() }).optional(),
});
const createdSchema = z.object({ sessionID: z.string().min(1) });

export function createdSession(body: unknown) {
  const outcome = outcomeSchema.safeParse(body);
  if (!outcome.success) {
    throw new Error(i18n.t('nativeRemote.invalidReply'));
  }
  if (outcome.data.status === 'failed') {
    throw new Error(outcome.data.error?.message ?? i18n.t('nativeRemote.commandFailed'));
  }
  if (outcome.data.status === 'unknown') {
    throw new Error(i18n.t('nativeRemote.creationUnknown'));
  }
  const created = createdSchema.safeParse(outcome.data.result);
  if (!created.success) {
    throw new Error(i18n.t('nativeRemote.invalidReply'));
  }
  return created.data.sessionID;
}

export function transcriptText(content: unknown): string {
  const text = stringSchema.safeParse(content);
  if (text.success) {
    return text.data;
  }
  if (Array.isArray(content)) {
    return content.map(item => transcriptText(item)).join('\n');
  }
  const value = record.safeParse(content);
  const partText = stringSchema.safeParse(value.success ? value.data.text : undefined);
  if (partText.success) {
    return partText.data;
  }
  return JSON.stringify(content, null, 2);
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
  if (!prompt.startsWith('/')) {
    const commandID = await connection.sendMessage(prompt, { queueIfOffline });
    return commandID;
  }
  const [command, ...args] = prompt.slice(1).split(/\s+/);
  if (!command || !['compact', 'new', 'skill', 'models', 'agents'].includes(command)) {
    throw new Error(i18n.t('nativeRemote.unsafeCommand'));
  }
  const commandID = await connection.sendCommand(command, args.join(' '));
  return commandID;
}
