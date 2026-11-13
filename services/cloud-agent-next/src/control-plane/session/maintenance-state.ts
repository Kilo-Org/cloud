import { z } from 'zod';
import {
  MAINTENANCE_PUBLICATION_EVENT,
  maintenanceOutcomeSchema,
  type MaintenanceOutcome,
} from '../../shared/pr-maintenance.js';
import type { SessionMetadata } from '../../persistence/session-metadata.js';
import type { ControlPlanePromptPayload } from '../../shared/control-plane-protocol.js';

export const MAINTENANCE_STOPPED_AT_KEY = 'pr-maintenance/stopped-at';
export const MAINTENANCE_STOP_TOMBSTONE_KEY = 'pr-maintenance/stopped-identity';
export const maintenanceStopIdentitySchema = z
  .object({ watchId: z.uuid(), attemptId: z.uuid(), messageId: z.string().min(1).max(128) })
  .strict();
const outcomeKey = (messageId: string) => `pr-maintenance/outcome/${messageId}`;
const historyKey = 'pr-maintenance/outcome-history';
const historySchema = z
  .object({
    messageIds: z.array(z.string().min(1).max(128)).max(32),
    resultMessageId: z.string().nullable(),
    publicationMessageId: z.string().nullable(),
  })
  .strict();

export async function maintenanceRegistrationStopped(
  storage: DurableObjectStorage,
  metadata: SessionMetadata
): Promise<boolean> {
  if (metadata.chat?.kind !== 'maintenance') return false;
  const identity = maintenanceStopIdentitySchema.safeParse(
    await storage.get(MAINTENANCE_STOP_TOMBSTONE_KEY)
  );
  return (
    identity.success &&
    identity.data.watchId === metadata.chat.watchId &&
    identity.data.attemptId === metadata.chat.attemptId
  );
}

export async function maintenanceInitialMessageStopped(
  storage: DurableObjectStorage,
  metadata: SessionMetadata,
  messageId: string
): Promise<boolean> {
  if (metadata.chat?.kind !== 'maintenance') return false;
  const identity = maintenanceStopIdentitySchema.safeParse(
    await storage.get(MAINTENANCE_STOP_TOMBSTONE_KEY)
  );
  return (
    identity.success &&
    identity.data.watchId === metadata.chat.watchId &&
    identity.data.attemptId === metadata.chat.attemptId &&
    identity.data.messageId === messageId
  );
}

export function maintenanceMessage(
  metadata: SessionMetadata | null,
  intent: ControlPlanePromptPayload
): ControlPlanePromptPayload {
  return metadata?.chat?.kind === 'maintenance'
    ? { ...intent, finalization: { ...intent.finalization, autoCommit: false } }
    : intent;
}

export async function retainMaintenanceOutcome(
  storage: DurableObjectStorage,
  metadata: SessionMetadata | null,
  messageId: string,
  outcome: MaintenanceOutcome | undefined,
  messages: readonly { messageId: string }[] = []
) {
  if (metadata?.chat?.kind !== 'maintenance' || outcome === undefined) return;
  if (outcome.attemptId !== metadata.chat.attemptId || outcome.messageId !== messageId) return;
  if (
    outcome.result !== null &&
    outcome.resultMessageId !== undefined &&
    outcome.resultMessageId !== messageId
  ) {
    const sourceMessageId = outcome.resultMessageId;
    if (!messages.some(message => message.messageId === sourceMessageId)) return;
    await retainMaintenanceOutcome(
      storage,
      metadata,
      outcome.resultMessageId,
      {
        attemptId: outcome.attemptId,
        messageId: outcome.resultMessageId,
        result: outcome.result,
        publication: {
          status: 'not_attempted',
          reason: 'Publication is retained on its original message.',
        },
      },
      messages
    );
    outcome = { ...outcome, result: null };
  }
  if (
    outcome.publication.status === 'published' &&
    (outcome.publication.repoUrl !== metadata.chat.publication.repoUrl ||
      outcome.publication.headRef !== metadata.chat.publication.headRef)
  )
    return;
  const existing = await readMaintenanceOutcome(storage, messageId);
  const retained: MaintenanceOutcome = {
    ...existing,
    ...outcome,
    result: outcome.result ?? existing?.result ?? null,
    publication:
      outcome.publication.status === 'not_attempted' && existing?.publication.status === 'published'
        ? existing.publication
        : outcome.publication,
    ...((outcome.workspace ?? existing?.workspace)
      ? { workspace: outcome.workspace ?? existing?.workspace }
      : {}),
  };
  const parsedHistory = historySchema.safeParse(await storage.get(historyKey));
  const history = parsedHistory.success
    ? parsedHistory.data
    : { messageIds: [], resultMessageId: null, publicationMessageId: null };
  const order = (id: string) => messages.findIndex(message => message.messageId === id);
  const isNewer = (id: string | null) => id === null || order(messageId) >= order(id);
  const resultMessageId =
    retained.result && isNewer(history.resultMessageId) ? messageId : history.resultMessageId;
  const publicationMessageId =
    retained.publication.status === 'published' && isNewer(history.publicationMessageId)
      ? messageId
      : history.publicationMessageId;
  const allIds = [...new Set([...history.messageIds, messageId])].sort(
    (left, right) => order(left) - order(right)
  );
  const messageIds = allIds.slice(-32);
  await storage.put({
    [outcomeKey(messageId)]: retained,
    [historyKey]: { messageIds, resultMessageId, publicationMessageId },
  });
  const expired = [
    ...new Set([
      ...allIds.slice(0, -32),
      ...[history.resultMessageId, history.publicationMessageId].filter(
        (id): id is string => id !== null && !messageIds.includes(id)
      ),
    ]),
  ].filter(id => id !== resultMessageId && id !== publicationMessageId);
  if (expired.length) await storage.delete(expired.map(outcomeKey));
}

export async function readMaintenanceOutcome(
  storage: DurableObjectStorage,
  messageId: string | undefined
) {
  if (messageId === undefined) return null;
  const parsed = maintenanceOutcomeSchema.safeParse(await storage.get(outcomeKey(messageId)));
  return parsed.success ? parsed.data : null;
}

export async function readMaintenanceStop(storage: DurableObjectStorage) {
  const parsed = z
    .number()
    .int()
    .positive()
    .safeParse(await storage.get(MAINTENANCE_STOPPED_AT_KEY));
  return parsed.success ? parsed.data : null;
}

export async function readMaintenanceAttemptResult(
  storage: DurableObjectStorage,
  messages: readonly { messageId: string }[]
) {
  const parsed = historySchema.safeParse(await storage.get(historyKey));
  const anchors = parsed.success
    ? [parsed.data.resultMessageId, parsed.data.publicationMessageId]
    : [];
  const ids = [
    ...new Set([
      ...messages.slice(-32).map(message => message.messageId),
      ...anchors.filter((id): id is string => id !== null),
    ]),
  ];
  const outcomes = (await Promise.all(ids.map(id => readMaintenanceOutcome(storage, id))))
    .filter((outcome): outcome is MaintenanceOutcome => outcome !== null)
    .sort(
      (left, right) =>
        messages.findIndex(message => message.messageId === left.messageId) -
        messages.findIndex(message => message.messageId === right.messageId)
    );
  const latestId = messages.at(-1)?.messageId;
  const latest = outcomes.find(outcome => outcome.messageId === latestId);
  const resultOutcome = outcomes.findLast(outcome => outcome.result !== null);
  const published = outcomes.findLast(outcome => outcome.publication.status === 'published');
  const workspace = latest?.workspace;
  const verified = outcomes.findLast(
    outcome =>
      outcome.publication.status === 'published' &&
      (workspace?.status === 'observed'
        ? !workspace.dirty &&
          outcome.publication.pushedHeadSha === workspace.headSha &&
          outcome.publication.remoteHeadSha === workspace.remoteHeadSha &&
          Date.parse(workspace.verifiedAt) >= Date.parse(outcome.publication.verifiedAt)
        : outcome.messageId === latestId && workspace === undefined)
  );
  const previousWorkspace = resultOutcome?.workspace;
  const unverifiedWork =
    workspace?.status === 'unavailable' ||
    (workspace?.status === 'observed' &&
      (workspace.dirty ||
        workspace.headSha !== workspace.remoteHeadSha ||
        (resultOutcome?.messageId !== latestId &&
          resultOutcome !== undefined &&
          (previousWorkspace?.status !== 'observed' ||
            previousWorkspace.headSha !== workspace.headSha))));
  const publication =
    verified?.publication ??
    (published || unverifiedWork
      ? {
          status: 'unknown' as const,
          reason:
            workspace?.status === 'unavailable'
              ? workspace.reason
              : 'maintenance_continuation_has_unpublished_or_unverified_work',
        }
      : (latest?.publication ?? null));
  return {
    result: resultOutcome?.result
      ? { ...resultOutcome.result, ...(publication ? { publication } : {}) }
      : null,
    publication,
    resultMessageId: resultOutcome?.messageId ?? null,
    publicationMessageId: verified?.messageId ?? latest?.messageId ?? null,
    lastPublished: published
      ? { messageId: published.messageId, publication: published.publication }
      : null,
    workspace: workspace ?? null,
  };
}

export async function retainMaintenancePublicationEvent(
  storage: DurableObjectStorage,
  metadata: SessionMetadata | null,
  messages: readonly { messageId: string }[],
  event: { type: string; properties: Record<string, unknown> }
): Promise<boolean> {
  if (event.type !== MAINTENANCE_PUBLICATION_EVENT) return false;
  const parsed = maintenanceOutcomeSchema.safeParse(event.properties);
  if (
    parsed.success &&
    parsed.data.result === null &&
    messages.some(message => message.messageId === parsed.data.messageId)
  ) {
    const existing = await readMaintenanceOutcome(storage, parsed.data.messageId);
    if (existing?.result) return true;
    await retainMaintenanceOutcome(storage, metadata, parsed.data.messageId, parsed.data, messages);
  }
  return true;
}
