import { z } from 'zod';
import {
  hasUndisplayableKilo2Assets,
  hasUnresolvedKilo2Assets,
  readKilo2Messages,
} from './kilo2-source-messages';
import type { NativeEvent, NativeSessionState } from './native-sync';
import {
  withDisplayLocation,
  type NativeSnapshotMessage,
  type NativeSnapshotSession,
} from './native-sync-snapshot';
import { upsertByKey, upsertByRequestId } from './pending-requests';
import { permissionAskedIdentitySchema } from './schemas';
import type { SessionSnapshot, UnreadablePermissionState, UnreadableQuestionState } from './types';

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
// A card can only be answered for an identity the runner can match, so an entry
// with an empty `requestID` falls through to the identity rule below.
const inventoryPermissionSchema = z
  .object({ requestID: z.string().min(1), tool: z.string(), summary: z.string() })
  .passthrough();
const inventoryQuestionSchema = z
  .object({ requestID: z.string().min(1), fields: z.array(fieldSchema) })
  .passthrough();
/** What an entry still says about itself when its scope cannot be read. */
const inventoryIdentitySchema = z.object({ requestID: z.string().min(1) }).passthrough();
/**
 * What a live form still says about itself when its fields cannot be read. The
 * question kind stays required: a form this list never held — another kind, or
 * one whose metadata cannot be read — is not a question request, so announcing
 * it as one would name a request this list does not own and could not clear.
 */
const formIdentitySchema = z
  .object({
    id: z.string().min(1),
    metadata: z.object({ kind: z.literal('question') }).passthrough(),
  })
  .passthrough();
const inventorySchema = z.object({
  permissions: z.array(z.unknown()).optional(),
  questions: z.array(z.unknown()).optional(),
});
const recordSchema = z.record(z.string(), z.unknown());
export type NativePendingRequests = {
  permissions: z.infer<typeof permissionSchema>[];
  questions: z.infer<typeof questionSchema>[];
  /** Question requests this app could not read, oldest first. */
  unreadableQuestions: UnreadableQuestionState[];
  /** Permission requests this app could not read, oldest first. */
  unreadablePermissions: UnreadablePermissionState[];
};
export type NativePendingQuestion = z.infer<typeof questionSchema>;
export type NativeConversation = {
  source: { version: 'v2'; runtime: 'native' };
  session: NativeSnapshotSession | undefined;
  nativeMessages: NativeSnapshotMessage[];
  messages: SessionSnapshot['messages'];
  incompleteMessageIDs: string[];
  /** Count of transcript parts still missing after recovery; zero when whole. */
  recoveryGaps: number;
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
    // Entries are optional so one unreadable card no longer decides the whole
    // inventory; a `pending` that is absent, null or wrongly shaped is still
    // unreadable as a whole and clears every list.
    const inventory = inventorySchema.safeParse(
      wrapper.success ? wrapper.data['pending'] : undefined
    );
    if (!inventory.success)
      return { permissions: [], questions: [], unreadableQuestions: [], unreadablePermissions: [] };
    const permissions: NativePendingRequests['permissions'] = [];
    const unreadable = new Set<string>();
    for (const entry of inventory.data.permissions ?? []) {
      const parsed = inventoryPermissionSchema.safeParse(entry);
      if (parsed.success) {
        permissions.push({
          ...parsed.data,
          id: parsed.data.requestID,
          action: parsed.data.tool,
          resources: [parsed.data.summary],
        });
        continue;
      }
      // No card may stand for a scope this app cannot read, but it can still
      // name the request; an entry with no readable identity is dropped.
      const identity = inventoryIdentitySchema.safeParse(entry);
      if (identity.success) unreadable.add(identity.data.requestID);
    }
    const questions: NativePendingRequests['questions'] = [];
    const unreadableQuestionIDs = new Set<string>();
    for (const entry of inventory.data.questions ?? []) {
      const parsed = inventoryQuestionSchema.safeParse(entry);
      // A card with nothing to answer is not a readable question either: the
      // runner cannot prompt for a choice it never describes.
      if (parsed.success && parsed.data.fields.length > 0) {
        questions.push({
          ...parsed.data,
          id: parsed.data.requestID,
          metadata: { kind: 'question' as const },
        });
        continue;
      }
      // No card may stand for a form this app cannot read, but it can still
      // name the question; an entry with no readable identity is dropped.
      const identity = inventoryIdentitySchema.safeParse(entry);
      if (identity.success) unreadableQuestionIDs.add(identity.data.requestID);
    }
    return {
      permissions,
      questions,
      // The runner inventory is the authoritative snapshot, so it also rebuilds
      // unreadable notices from this frame alone: a request it no longer lists
      // is settled, and one it lists readably has a card instead.
      unreadableQuestions: [...unreadableQuestionIDs].map(requestId => ({ requestId })),
      unreadablePermissions: [...unreadable].map(requestId => ({ requestId })),
    };
  }
  const native = recordSchema.safeParse(wrapper.success ? wrapper.data['data'] : undefined);
  const data = recordSchema.safeParse(native.success ? native.data['data'] : undefined);
  if (!data.success) return pending;
  if (event.type === 'permission.asked') {
    const parsed = permissionSchema.safeParse(data.data);
    if (parsed.success) {
      const permission = parsed.data;
      return {
        ...pending,
        // In place, so a replayed request keeps its place in the oldest-first list.
        permissions: [...upsertByKey(pending.permissions, permission, item => item.id)],
        // A readable request supersedes an unreadable notice for the same id.
        unreadablePermissions: pending.unreadablePermissions.filter(
          item => item.requestId !== permission.id
        ),
      };
    }
    const identity = permissionAskedIdentitySchema.safeParse(data.data);
    if (!identity.success) return pending;
    // The scope could not be read, so no consent card may stand for this id: a
    // card already shown for it would describe a scope the app no longer holds.
    return {
      ...pending,
      permissions: pending.permissions.filter(item => item.id !== identity.data.id),
      // In place, so a replayed request keeps its place in the oldest-first list.
      unreadablePermissions: [
        ...upsertByRequestId(pending.unreadablePermissions, { requestId: identity.data.id }),
      ],
    };
  }
  if (event.type === 'permission.replied')
    return {
      ...pending,
      permissions: pending.permissions.filter(item => item.id !== data.data['requestID']),
      unreadablePermissions: pending.unreadablePermissions.filter(
        item => item.requestId !== data.data['requestID']
      ),
    };
  if (event.type === 'form.created') {
    const form = questionSchema.safeParse(data.data['form']);
    // A form with no fields leaves a card with nothing to answer, so it is not
    // readable either and falls through to the identity notice below.
    if (form.success && form.data.fields.length > 0)
      return {
        ...pending,
        // In place, so a replayed form keeps its place in the oldest-first list.
        questions: [...upsertByKey(pending.questions, form.data, item => item.id)],
        // A readable form supersedes an unreadable notice for the same id.
        unreadableQuestions: pending.unreadableQuestions.filter(
          item => item.requestId !== form.data.id
        ),
      };
    const identity = formIdentitySchema.safeParse(data.data['form']);
    if (!identity.success) return pending;
    // The fields could not be read, so no question card may stand for this id:
    // a card already shown for it would describe questions the app no longer holds.
    return {
      ...pending,
      questions: pending.questions.filter(item => item.id !== identity.data.id),
      // In place, so a replayed request keeps its place in the oldest-first list.
      unreadableQuestions: [
        ...upsertByRequestId(pending.unreadableQuestions, { requestId: identity.data.id }),
      ],
    };
  }
  if (event.type === 'form.replied' || event.type === 'form.cancelled')
    return {
      ...pending,
      questions: pending.questions.filter(item => item.id !== data.data['id']),
      unreadableQuestions: pending.unreadableQuestions.filter(
        item => item.requestId !== data.data['id']
      ),
    };
  return pending;
}

/**
 * Parts the recovery snapshot can still fill, deduplicated by identity. A
 * projection failure changes nothing here: those parts leave the transcript
 * through `error`, and counting them as gaps would promise a Retry the
 * recovery loop cannot deliver.
 */
export function retryableGapCount(
  messages: NativeSnapshotMessage[],
  pendingSnapshotMessageIDs: string[] | undefined,
  unresolvedMessageIDs: ReadonlySet<string>,
  projectionFailed: boolean
): number {
  if (projectionFailed) {
    return new Set([
      ...messages.filter(item => item.incomplete).map(item => item.message.id),
      ...(pendingSnapshotMessageIDs ?? []),
    ]).size;
  }
  return new Set([
    ...messages.filter(item => item.incomplete).map(item => item.message.id),
    ...(pendingSnapshotMessageIDs ?? []),
    ...unresolvedMessageIDs,
  ]).size;
}

/** Shared native display boundary. It never opens a socket or owns replay/recovery. */
export function readNativeConversation(state: NativeSessionState): NativeConversation {
  const complete = state.messages.filter(item => !item.incomplete);
  // No authorized bytes means no projection either way. A reference that a later
  // snapshot may still authorize is a recovery gap and stays explicit; one that no
  // snapshot can ever authorize is simply not displayed, as live and history do.
  const undisplayable = complete.filter(item =>
    hasUndisplayableKilo2Assets(item.message, state.assetURLs)
  );
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
  const session = state.session && withDisplayLocation(state.session);
  const last = state.messages.at(-1)?.message;
  let messages: SessionSnapshot['messages'] = [];
  let projectionError: string | undefined;
  const unresolvedByProjection = new Set(unresolved.map(item => item.message.id));
  if (session) {
    try {
      messages = readKilo2Messages(
        session,
        complete
          .filter(
            item => !undisplayable.includes(item) && !unresolvedByProjection.has(item.message.id)
          )
          .map(item => item.message),
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
  const recoveryGaps = retryableGapCount(
    state.messages,
    state.pendingSnapshotMessageIDs,
    unresolvedByProjection,
    projectionError !== undefined
  );
  return {
    source: { version: 'v2' as const, runtime: 'native' as const },
    // Keep the exact canonical values available to details, usage and export consumers.
    session: state.session,
    nativeMessages: state.messages,
    messages,
    incompleteMessageIDs,
    recoveryGaps,
    pending: state.pending,
    // A disconnected pre-snapshot window still shows progress, not a blank screen.
    loading: !session && !state.snapshot && !state.error,
    // Only real failures: a missing transcript part is a recovery gap, not an error.
    error:
      state.error ??
      projectionError ??
      (!session && state.snapshot
        ? 'The native snapshot has no session metadata.'
        : last?.type === 'idle' && last.error
          ? last.error.message
          : undefined),
  };
}
