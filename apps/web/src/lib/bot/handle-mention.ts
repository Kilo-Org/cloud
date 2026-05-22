import { resolveKiloUserId, unlinkKiloUser, type PlatformIdentity } from '@/lib/bot-identity';
import {
  canKiloUserAccessPlatformIntegration,
  getPlatformIntegration,
} from '@/lib/bot/platform-helpers';
import { botPlatforms } from '@/lib/bot/platforms';
import { processLinkedMessage } from '@/lib/bot/run';
import { findUserById } from '@/lib/user';
import { captureException } from '@sentry/nextjs';
import type { PlatformIntegration } from '@kilocode/db';
import type { Message, StateAdapter, Thread } from 'chat';

export async function handleIncomingBotMention({
  thread,
  message,
  state,
  identity: providedIdentity,
  platformIntegration: providedPlatformIntegration,
}: {
  thread: Thread;
  message: Message;
  state: StateAdapter;
  identity?: PlatformIdentity;
  platformIntegration?: PlatformIntegration;
}): Promise<void> {
  const botPlatform = botPlatforms.requireByAdapter(thread.adapter);
  const identity = providedIdentity ?? (await botPlatform.getIdentity({ thread, message }));
  const [platformIntegration, kiloUserId] = await Promise.all([
    providedPlatformIntegration ?? getPlatformIntegration(identity),
    resolveKiloUserId(state, identity),
  ]);

  if (!platformIntegration) {
    captureException(new Error('No active platform integration found'), {
      extra: { platform: identity.platform, teamId: identity.teamId },
    });
    return;
  }

  if (!botPlatform.isEnabledForBot(platformIntegration)) {
    return;
  }

  if (!(await botPlatform.canHandleMessage({ thread, message, platformIntegration }))) {
    return;
  }

  if (!kiloUserId) {
    await botPlatform.promptLinkAccount({
      thread,
      message,
      identity,
      platformIntegration,
      state,
    });
    return;
  }

  const user = await findUserById(kiloUserId);

  if (!user) {
    await unlinkKiloUser(state, identity);
    await botPlatform.promptLinkAccount({
      thread,
      message,
      identity,
      platformIntegration,
      state,
    });
    return;
  }

  if (!(await canKiloUserAccessPlatformIntegration(platformIntegration, user.id))) {
    await unlinkKiloUser(state, identity);
    await botPlatform.promptLinkAccount({
      thread,
      message,
      identity,
      platformIntegration,
      state,
    });
    return;
  }

  try {
    await processLinkedMessage({ thread, message, platformIntegration, user });
  } catch (error) {
    console.error('[Bot] Unhandled error in message handler:', error);
    await thread.post({ markdown: 'Sorry, something went wrong while processing your message.' });
  }
}
