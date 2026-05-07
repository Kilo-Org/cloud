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
  handleAction?(event: ActionEvent): Promise<void>;
  handleAssistantThreadStarted?(event: AssistantThreadStartedEvent): Promise<void>;
  handleMemberJoinedChannel?(event: MemberJoinedChannelEvent): Promise<void>;
  handleAppHomeOpened?(event: AppHomeOpenedEvent): Promise<void>;
};
