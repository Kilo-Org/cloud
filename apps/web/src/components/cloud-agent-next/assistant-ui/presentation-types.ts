import type { ThreadMessageLike } from '@assistant-ui/react';
import type {
  MessageDeliveryState,
  PreparationAttempt,
  SessionCommit,
} from '@kilocode/cloud-agent-sdk';
import type { Part, StoredMessage } from '../types';

export type CloudPartPresentation = {
  id: string;
  messageId: string;
  source: Part;
  toolCallId?: string;
};

export type CloudMessagePresentation = {
  id: string;
  messageIds: readonly string[];
  sources: readonly StoredMessage[];
  parts: readonly CloudPartPresentation[];
  displayTimestamp: number;
  isStreaming: boolean;
  deliveryState?: MessageDeliveryState;
  isSending: boolean;
  preparations: readonly PreparationAttempt[];
  commits: readonly SessionCommit[];
};

export type CloudProjectedMessage = {
  presentation: CloudMessagePresentation;
  message: ThreadMessageLike;
};

export type CloudProjectionInput = {
  messages: readonly StoredMessage[];
  /** Explicit groups preserve historical and nested consumer presentation. */
  messageGroups?: readonly (readonly StoredMessage[])[];
  isStreaming: boolean;
  pendingMessages?: ReadonlyMap<string, MessageDeliveryState>;
  sendingMessageIds?: ReadonlySet<string>;
  preparationByMessageId?: ReadonlyMap<string, readonly PreparationAttempt[]>;
  commitsAfterMessage?: ReadonlyMap<string, readonly SessionCommit[]>;
};

export type CloudThreadState = {
  isLoading: boolean;
  isRunning: boolean;
  isReadOnly: boolean;
  isSendDisabled: boolean;
  canInterrupt: boolean;
};

export function cloudRuntimeGates(state: CloudThreadState) {
  return {
    isLoading: state.isLoading,
    isRunning: state.isRunning,
    isDisabled: state.isReadOnly,
    isSendDisabled: state.isReadOnly || state.isSendDisabled,
    canCancel: !state.isReadOnly && state.canInterrupt,
  };
}
