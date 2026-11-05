import { z } from 'zod';
import type { NativeEvent, NativeSessionConnection } from '@kilocode/cloud-agent-sdk';

const record = z.record(z.string(), z.unknown());
const permission = z.object({
  id: z.string(),
  action: z.string(),
  resources: z.array(z.string()),
  message: z.string().optional(),
});
const field = z.object({
  type: z.string(),
  key: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  custom: z.boolean().optional(),
  options: z.array(z.object({ value: z.string(), label: z.string().optional() })).optional(),
});
const question = z.object({
  id: z.string(),
  title: z.string(),
  metadata: z.object({ kind: z.literal('question') }),
  fields: z.array(field),
});
export type PendingPermission = z.infer<typeof permission>;
export type PendingQuestion = z.infer<typeof question>;

export function pendingRequests(events: NativeEvent[]) {
  const permissions = new Map<string, PendingPermission>();
  const questions = new Map<string, PendingQuestion>();
  for (const event of events) {
    const wrapper = record.safeParse(event.body);
    if (event.type === 'remote.state' && wrapper.success) {
      const inventory = z
        .object({
          permissions: z.array(
            z.object({ requestID: z.string(), tool: z.string(), summary: z.string() })
          ),
          questions: z.array(z.object({ requestID: z.string(), fields: z.array(field) })),
        })
        .safeParse(wrapper.data.pending);
      if (inventory.success) {
        permissions.clear();
        questions.clear();
        for (const item of inventory.data.permissions) {
          permissions.set(item.requestID, {
            id: item.requestID,
            action: item.tool,
            resources: [item.summary],
          });
        }
        for (const item of inventory.data.questions) {
          questions.set(item.requestID, {
            id: item.requestID,
            title: 'Question',
            metadata: { kind: 'question' },
            fields: item.fields,
          });
        }
      }
      continue;
    }
    const native = record.safeParse(wrapper.success ? wrapper.data.data : undefined);
    const data = record.safeParse(native.success ? native.data.data : undefined);
    if (!data.success) continue;
    if (event.type === 'permission.asked') {
      const parsed = permission.safeParse(data.data);
      if (parsed.success) permissions.set(parsed.data.id, parsed.data);
    }
    if (event.type === 'permission.replied' && typeof data.data.requestID === 'string')
      permissions.delete(data.data.requestID);
    if (event.type === 'form.created') {
      const parsed = question.safeParse(data.data.form);
      if (parsed.success) questions.set(parsed.data.id, parsed.data);
    }
    if (
      (event.type === 'form.replied' || event.type === 'form.cancelled') &&
      typeof data.data.id === 'string'
    )
      questions.delete(data.data.id);
  }
  return { permissions: [...permissions.values()], questions: [...questions.values()] };
}

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
