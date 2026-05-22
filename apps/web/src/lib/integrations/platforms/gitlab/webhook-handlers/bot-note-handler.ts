import { handleIncomingBotMention } from '@/lib/bot/handle-mention';
import { bot } from '@/lib/bot';
import {
  createGitLabMessageFromNotePayload,
  createGitLabSyntheticThread,
  type GitLabThreadContext,
} from '@/lib/bot/platforms/gitlab';
import { PLATFORM } from '@/lib/integrations/core/constants';
import type { NoteEventPayload } from '@/lib/integrations/platforms/gitlab/webhook-schemas';
import type { PlatformIntegration } from '@kilocode/db';

export async function handleGitLabNoteBotMention(
  payload: NoteEventPayload,
  integration: PlatformIntegration
): Promise<void> {
  const mergeRequest = payload.merge_request;
  if (!mergeRequest) return;

  const context: GitLabThreadContext = {
    integrationId: integration.id,
    projectId: payload.project_id,
    projectPath: payload.project.path_with_namespace,
    mrIid: mergeRequest.iid,
    noteId: payload.object_attributes.id,
    ...(payload.object_attributes.discussion_id
      ? { discussionId: payload.object_attributes.discussion_id }
      : {}),
  };
  const thread = createGitLabSyntheticThread({ context, platformIntegration: integration });
  const message = createGitLabMessageFromNotePayload(payload, context);

  await bot.initialize();
  await handleIncomingBotMention({
    thread,
    message,
    state: bot.getState(),
    identity: {
      platform: PLATFORM.GITLAB,
      teamId: integration.id,
      userId: payload.user.id.toString(),
    },
    platformIntegration: integration,
  });
}
