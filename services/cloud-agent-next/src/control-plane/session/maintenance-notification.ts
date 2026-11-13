import type { SessionMetadata } from '../../persistence/session-metadata.js';
import type { NotificationsBinding } from '../../notifications-binding.js';
import { readMaintenanceAttemptResult, readMaintenanceStop } from './maintenance-state.js';
import { logger } from '../../logger.js';

const notificationKey = 'pr-maintenance/completion-notice';

export async function notifyMaintenanceCompletion(input: {
  storage: DurableObjectStorage;
  metadata: SessionMetadata;
  messages: readonly { messageId: string }[];
  notifications: NotificationsBinding | undefined;
}): Promise<void> {
  const chat = input.metadata.chat;
  const kiloSessionId = input.metadata.auth.kiloSessionId;
  if (chat?.kind !== 'maintenance' || !kiloSessionId) return;
  if ((await readMaintenanceStop(input.storage)) !== null) return;
  if ((await input.storage.get(notificationKey)) === chat.attemptId) return;
  const state = await readMaintenanceAttemptResult(input.storage, input.messages);
  const result = state.result;
  const publication = state.publication;
  if (
    !result ||
    result.needsInput !== null ||
    publication?.status !== 'published' ||
    publication.pushedHeadSha === publication.observedHeadSha
  )
    return;
  if (
    !result.verification.some(check => check.outcome === 'passed') ||
    result.verification.some(check => check.outcome === 'failed')
  )
    return;
  if (
    !result.changedFiles.length &&
    !result.problems.some(problem => problem.disposition === 'addressed')
  )
    return;
  if (!input.notifications?.sendCloudAgentSessionNotification) {
    logger.warn('Maintenance completion notification binding unavailable');
    return;
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await input.notifications.sendCloudAgentSessionNotification({
        userId: input.metadata.identity.userId,
        cliSessionId: kiloSessionId,
        executionId: `maintenance:${chat.attemptId}`,
        status: 'completed',
        category: 'status',
        body: 'PR maintenance published changes. Review and check results remain separate.',
        suppressIfViewingSession: true,
      });
      if (response.dispatched || response.reason === 'suppressed_preference') {
        await input.storage.put(notificationKey, chat.attemptId);
        return;
      }
    } catch {
      if (attempt === 0) continue;
    }
  }
  logger.warn('Maintenance completion notification failed after bounded retry');
}
