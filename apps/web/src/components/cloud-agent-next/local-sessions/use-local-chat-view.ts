'use client';

import { useMemo } from 'react';
import type {
  CustomerBillingFailure,
  MessageDeliveryState,
  SessionStatusIndicator,
} from '@kilocode/cloud-agent-sdk';
import type { TranscriptPhase } from '../transcript-switch';
import type { StoredMessage } from '../types';
import { localTranscript } from './local-session';
import type { LocalSession } from './local-session';

type Transcript = {
  staticMessages: StoredMessage[];
  dynamicMessages: StoredMessage[];
  pendingMessages: ReadonlyMap<string, MessageDeliveryState>;
  sendingMessageIds: ReadonlySet<string>;
};

type LocalChatView = {
  isLocalTranscript: boolean;
  /** A chat created here that the server did not create. */
  failure: LocalSession | null;
  transcript: Transcript;
  statusIndicator: SessionStatusIndicator | null;
  billingFailure: CustomerBillingFailure | null;
};

const NO_MESSAGES: StoredMessage[] = [];
const NO_PENDING_MESSAGES = new Map<string, never>();
const NO_MESSAGE_IDS: ReadonlySet<string> = new Set();
const CREATING_SESSION: SessionStatusIndicator = {
  type: 'progress',
  message: 'Creating session…',
  timestamp: 0,
};

/**
 * What the chat page shows for a chat created here until its live transcript
 * loads: the record's own transcript, its progress, and its failure. Other
 * chats show the live values unchanged.
 */
export function useLocalChatView({
  localSession,
  transcriptPhase,
  live,
}: {
  localSession: LocalSession | null;
  transcriptPhase: TranscriptPhase;
  live: Transcript & {
    statusIndicator: SessionStatusIndicator | null;
    billingFailure: CustomerBillingFailure | null;
  };
}): LocalChatView {
  const localMessages = useMemo(
    () => (localSession ? localTranscript(localSession) : NO_MESSAGES),
    [localSession]
  );
  const isLocalTranscript = transcriptPhase === 'local';
  const failure = isLocalTranscript && localSession?.sync.state === 'failed' ? localSession : null;
  const failedSync = failure?.sync.state === 'failed' ? failure.sync : null;
  const { statusIndicator, billingFailure, ...liveTranscript } = live;
  return {
    isLocalTranscript,
    failure,
    transcript: isLocalTranscript
      ? {
          staticMessages: NO_MESSAGES,
          dynamicMessages: localMessages,
          pendingMessages: NO_PENDING_MESSAGES,
          sendingMessageIds: NO_MESSAGE_IDS,
        }
      : liveTranscript,
    statusIndicator: isLocalTranscript
      ? localSession?.firstMessage && !failure
        ? CREATING_SESSION
        : null
      : statusIndicator,
    billingFailure: billingFailure ?? failedSync?.billingFailure ?? null,
  };
}
