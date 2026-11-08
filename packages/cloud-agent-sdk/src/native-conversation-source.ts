import { z } from 'zod';
import { hasUnresolvedKilo2Assets, readKilo2Messages } from './kilo2-source-messages';
import type { NativeEvent, NativeSessionState } from './native-sync';
import type { NativeSnapshotMessage, NativeSnapshotSession } from './native-sync-snapshot';
import type { SessionSnapshot } from './types';

const permissionSchema = z
  .object({
    id: z.string(),
    action: z.string(),
    resources: z.array(z.string()),
    message: z.string().optional(),
  })
  .passthrough();
const fieldSchema = z
  .object({
    type: z.string(),
    key: z.string(),
    title: z.string().optional(),
    description: z.string().optional(),
    custom: z.boolean().optional(),
    options: z
      .array(z.object({ value: z.string(), label: z.string().optional() }).passthrough())
      .optional(),
  })
  .passthrough();
const questionSchema = z
  .object({
    id: z.string(),
    title: z.string().optional(),
    metadata: z.object({ kind: z.literal('question') }).passthrough(),
    fields: z.array(fieldSchema),
  })
  .passthrough();
const inventorySchema = z.object({
  permissions: z.array(
    z.object({ requestID: z.string(), tool: z.string(), summary: z.string() }).passthrough()
  ),
  questions: z.array(
    z.object({ requestID: z.string(), fields: z.array(fieldSchema) }).passthrough()
  ),
});
const recordSchema = z.record(z.string(), z.unknown());
export type NativePendingRequests = {
  permissions: z.infer<typeof permissionSchema>[];
  questions: z.infer<typeof questionSchema>[];
};
export type NativePendingQuestion = z.infer<typeof questionSchema>;
export type NativeConversation = {
  source: { version: 'v2'; runtime: 'native' };
  session: NativeSnapshotSession | undefined;
  nativeMessages: NativeSnapshotMessage[];
  messages: SessionSnapshot['messages'];
  incompleteMessageIDs: string[];
  pending: NativePendingRequests;
  loading: boolean;
  error: string | undefined;
};

/** Pending inventory is maintained outside the bounded diagnostic event log. */
export function reduceNativePendingRequests(
  pending: NativePendingRequests,
  event: NativeEvent
): NativePendingRequests {
  const wrapper = recordSchema.safeParse(event.body);
  if (event.type === 'remote.state') {
    const inventory = inventorySchema.safeParse(
      wrapper.success ? wrapper.data['pending'] : undefined
    );
    if (!inventory.success) return { permissions: [], questions: [] };
    return {
      permissions: inventory.data.permissions.map(item => ({
        ...item,
        id: item.requestID,
        action: item.tool,
        resources: [item.summary],
      })),
      questions: inventory.data.questions.map(item => ({
        ...item,
        id: item.requestID,
        metadata: { kind: 'question' as const },
      })),
    };
  }
  const native = recordSchema.safeParse(wrapper.success ? wrapper.data['data'] : undefined);
  const data = recordSchema.safeParse(native.success ? native.data['data'] : undefined);
  if (!data.success) return pending;
  if (event.type === 'permission.asked') {
    const parsed = permissionSchema.safeParse(data.data);
    if (!parsed.success) return pending;
    const permission = parsed.data;
    return {
      ...pending,
      permissions: [...pending.permissions.filter(item => item.id !== permission.id), permission],
    };
  }
  if (event.type === 'permission.replied')
    return {
      ...pending,
      permissions: pending.permissions.filter(item => item.id !== data.data['requestID']),
    };
  if (event.type === 'form.created') {
    const form = questionSchema.safeParse(data.data['form']);
    if (form.success)
      return {
        ...pending,
        questions: [...pending.questions.filter(item => item.id !== form.data.id), form.data],
      };
  }
  if (event.type === 'form.replied' || event.type === 'form.cancelled')
    return { ...pending, questions: pending.questions.filter(item => item.id !== data.data['id']) };
  return pending;
}

/** Shared native display boundary. It never opens a socket or owns replay/recovery. */
export function readNativeConversation(state: NativeSessionState): NativeConversation {
  const complete = state.messages.filter(item => !item.incomplete);
  const unresolved = complete.filter(item =>
    hasUnresolvedKilo2Assets(item.message, state.assetURLs)
  );
  const incompleteMessageIDs = [
    ...new Set([
      ...state.messages.filter(item => item.incomplete).map(item => item.message.id),
      ...(state.pendingSnapshotMessageIDs ?? []),
      ...unresolved.map(item => item.message.id),
    ]),
  ];
  const session = state.session && {
    ...state.session,
    location: { directory: state.session.origin.directory },
  };
  const last = state.messages.at(-1)?.message;
  let messages: SessionSnapshot['messages'] = [];
  let projectionError: string | undefined;
  if (session) {
    try {
      messages = readKilo2Messages(
        session,
        complete.filter(item => !unresolved.includes(item)).map(item => item.message),
        { assetURLs: state.assetURLs }
      );
    } catch (error) {
      projectionError =
        error instanceof Error ? error.message : 'Native transcript projection failed.';
      for (const item of complete)
        if (!incompleteMessageIDs.includes(item.message.id))
          incompleteMessageIDs.push(item.message.id);
    }
  }
  return {
    source: { version: 'v2' as const, runtime: 'native' as const },
    // Keep the exact canonical values available to details, usage and export consumers.
    session: state.session,
    nativeMessages: state.messages,
    messages,
    incompleteMessageIDs,
    pending: state.pending,
    loading: !session && !state.snapshot && !state.error && state.connection !== 'disconnected',
    error:
      state.error ??
      projectionError ??
      (incompleteMessageIDs.length
        ? `Native transcript recovery is incomplete: ${incompleteMessageIDs.join(', ')}.`
        : !session && state.snapshot
          ? 'The native snapshot has no session metadata.'
          : last?.type === 'idle' && last.error
            ? last.error.message
            : undefined),
  };
}
