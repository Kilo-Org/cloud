import type { PlatformIdentity } from '@/lib/bot-identity';
import type { Platform } from '@/lib/integrations/core/constants';
import type { PlatformIntegration } from '@kilocode/db';
import type {
  ActionEvent,
  AppHomeOpenedEvent,
  AssistantThreadStartedEvent,
  MemberJoinedChannelEvent,
  Message,
  StateAdapter,
  Thread,
} from 'chat';
import type { ContextTriggerMessage } from './shared';

export type RequesterInfo = {
  displayName: string;
  messageLink?: string;
  platform: Platform;
};

/**
 * Called when the bot's synchronous turn is done. `handedOff` is true when
 * the bot delegated to a cloud agent session that keeps running after this
 * call — in that case GitHub leaves only the in-progress 👀 reaction in
 * place and does not add 👍, since the work is not actually finished.
 */
export type StopProcessingIndicator = (outcome?: { handedOff?: boolean }) => Promise<void>;

export type BotPlatform = {
  platform: Platform;
  documentationUrl: string;
  usesGenericLinkAccountRoute?: boolean;
  getIdentity(params: { thread: Thread; message: Message }): Promise<PlatformIdentity>;
  isEnabledForBot(integration: PlatformIntegration): boolean;
  /**
   * Per-message gate that runs after `isEnabledForBot`. Defaults to allowing
   * every message. GitHub overrides this to reject messages from repositories
   * that are not linked to the integration.
   */
  canHandleMessage(params: {
    thread: Thread;
    message: Message;
    platformIntegration: PlatformIntegration;
  }): Promise<boolean> | boolean;
  promptLinkAccount(params: {
    thread: Thread;
    message: Message;
    identity: PlatformIdentity;
    platformIntegration: PlatformIntegration;
    state: StateAdapter;
  }): Promise<void>;
  withAuthContext<T>(params: {
    platformIntegration: PlatformIntegration;
    fn: () => Promise<T>;
  }): Promise<T>;
  getConversationContext(params: {
    thread: Thread;
    triggerMessage: ContextTriggerMessage;
    platformIntegration: PlatformIntegration;
  }): Promise<string>;
  getRequesterInfo(params: {
    message: Message;
    platformIntegration: PlatformIntegration;
    displayName: string;
  }): Promise<RequesterInfo>;
  /**
   * Signal that the bot is processing the user's message. Slack/Linear use
   * the platform-native typing indicator. GitHub has no typing concept and
   * reacts to the triggering comment instead: 👀 on start, then 👍 added
   * by the stop callback. Both the initial bot run and the cloud-agent
   * callback go through this same start/stop lifecycle, with `handedOff`
   * suppressing the 👍 when more work is still in flight.
   */
  startProcessingIndicator(params: {
    thread: Thread;
    messageId: string;
    status?: string;
  }): Promise<StopProcessingIndicator>;
  handleAction?(event: ActionEvent): Promise<void>;
  handleAssistantThreadStarted?(event: AssistantThreadStartedEvent): Promise<void>;
  handleMemberJoinedChannel?(event: MemberJoinedChannelEvent): Promise<void>;
  handleAppHomeOpened?(event: AppHomeOpenedEvent): Promise<void>;
};
