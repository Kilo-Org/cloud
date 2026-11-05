import { type NativeEvent, type NativeSessionConnection } from '@kilocode/cloud-agent-sdk';
import { z } from 'zod';
import { i18n } from '@/i18n';

const record = z.record(z.string(), z.unknown());
const stringSchema = z.string();
const permissionSchema = z.object({
  id: z.string(),
  action: z.string(),
  resources: z.array(z.string()),
  message: z.string().optional(),
});
const fieldSchema = z.object({
  type: z.string(),
  key: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  custom: z.boolean().optional(),
  options: z.array(z.object({ value: z.string(), label: z.string().optional() })).optional(),
});
const questionSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  metadata: z.object({ kind: z.literal('question') }),
  fields: z.array(fieldSchema),
});
const inventorySchema = z.object({
  permissions: z.array(z.object({ requestID: z.string(), tool: z.string(), summary: z.string() })),
  questions: z.array(z.object({ requestID: z.string(), fields: z.array(fieldSchema) })),
});
export type PendingQuestion = z.infer<typeof questionSchema>;
type PendingPermission = z.infer<typeof permissionSchema>;
export type NativePendingRequests = {
  permissions: PendingPermission[];
  questions: PendingQuestion[];
};

// Runner event bodies are opaque in the SDK; parse their native boundary here.
export function pendingRequests(events: NativeEvent[]) {
  const pending = {
    permissions: new Map<string, PendingPermission>(),
    questions: new Map<string, PendingQuestion>(),
  };
  const { permissions, questions } = pending;
  for (const event of events) {
    const wrapper = record.safeParse(event.body);
    if (event.type === 'remote.state') {
      const inventory = inventorySchema.safeParse(
        wrapper.success ? wrapper.data.pending : undefined
      );
      // A new inventory is authoritative, including an empty one.
      permissions.clear();
      questions.clear();
      if (inventory.success) {
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
            metadata: { kind: 'question' },
            fields: item.fields,
          });
        }
      }
    } else if (wrapper.success) {
      applyLiveRequest(event, wrapper.data, pending);
    }
  }
  return { permissions: [...permissions.values()], questions: [...questions.values()] };
}

type PendingMaps = {
  permissions: Map<string, PendingPermission>;
  questions: Map<string, PendingQuestion>;
};

function applyLiveRequest(
  event: NativeEvent,
  wrapper: Record<string, unknown>,
  { permissions, questions }: PendingMaps
) {
  const native = record.safeParse(wrapper.data);
  const data = record.safeParse(native.success ? native.data.data : undefined);
  if (!data.success) {
    return;
  }
  if (event.type === 'permission.asked') {
    const parsed = permissionSchema.safeParse(data.data);
    if (parsed.success) {
      permissions.set(parsed.data.id, parsed.data);
    }
  }
  if (event.type === 'permission.replied') {
    const requestID = stringSchema.safeParse(data.data.requestID);
    if (requestID.success) {
      permissions.delete(requestID.data);
    }
  }
  if (event.type === 'form.created') {
    const parsed = questionSchema.safeParse(data.data.form);
    if (parsed.success) {
      questions.set(parsed.data.id, parsed.data);
    }
  }
  if (event.type === 'form.replied' || event.type === 'form.cancelled') {
    const requestID = stringSchema.safeParse(data.data.id);
    if (requestID.success) {
      questions.delete(requestID.data);
    }
  }
}

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
