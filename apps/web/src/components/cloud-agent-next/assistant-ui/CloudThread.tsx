'use client';
import React from 'react';

import { useMemo, type ComponentProps, type ComponentType, type ReactNode } from 'react';
import { useAtomValue } from 'jotai';
import type { SessionManager } from '@kilocode/cloud-agent-sdk';
import type { ReadOnlyQuestionState } from '../QuestionToolStatus';
import { MessageNotSentError, ThreadPrimitive, type ThreadMessage } from '@assistant-ui/react';
import type { OpenChildSession } from '../ChildSessionSection';
import type { StoredMessage } from '../types';
import { isMessageStreaming } from '../types';
import { useOptionalManager, ReadOnlyCloudAgentBoundary } from '../CloudAgentProvider';
import { CloudMessage } from './CloudMessage';
import {
  CloudPresentationContext,
  CloudMessagePresentationContext,
} from './cloud-presentation-context';
import type { CloudMessagePresentation } from './presentation-types';
import { CloudChatRuntimeProvider } from './CloudChatRuntimeProvider';

type CloudThreadProps = {
  getChildMessages?: (sessionId: string) => StoredMessage[];
  onOpenChildSession?: OpenChildSession;
  onOpenPreparationDetails?: (attemptId: string) => void;
  depth?: number;
  presentationMode?: 'live' | 'historical';
  questionState?: ReadOnlyQuestionState;
  child?: boolean;
  children?: ReactNode;
  messageComponent?: ComponentType;
};
function ChildMessage() {
  return <CloudMessage child />;
}
/** Uses the host's viewport. Cloud owns follow, anchors and history position. */
function CloudThreadBody({
  getChildMessages,
  onOpenChildSession,
  onOpenPreparationDetails,
  depth = 0,
  presentationMode = 'live',
  child = false,
  children,
  messageComponent,
  questionState,
}: CloudThreadProps) {
  const renderMessage = useMemo(() => {
    const Component = messageComponent ?? (child ? ChildMessage : CloudMessage);
    return ({ message }: { message: ThreadMessage }) => {
      // External-store adds an empty optimistic assistant before the SDK responds.
      // Cloud renders only SDK rows; the page already owns the waiting indicator.
      if (message.metadata.isOptimistic) return null;
      return (
        <CloudMessagePresentationContext.Provider
          value={message.metadata.custom.cloud as CloudMessagePresentation}
        >
          <Component />
        </CloudMessagePresentationContext.Provider>
      );
    };
  }, [messageComponent, child]);
  const actions = useMemo(
    () => ({
      getChildMessages,
      onOpenChildSession,
      onOpenPreparationDetails,
      depth,
      presentationMode,
      questionState,
      renderChildTranscript: (
        messages: StoredMessage[],
        childDepth: number,
        currentGetter?: (sessionId: string) => StoredMessage[]
      ) => (
        <CloudReadOnlyThread
          messages={messages}
          depth={childDepth}
          child
          isStreaming={messages.some(isMessageStreaming)}
          getChildMessages={currentGetter}
          presentationMode={presentationMode}
          questionState={questionState}
          onOpenChildSession={onOpenChildSession}
        />
      ),
    }),
    [
      getChildMessages,
      onOpenChildSession,
      onOpenPreparationDetails,
      depth,
      presentationMode,
      questionState,
    ]
  );
  return (
    <CloudPresentationContext.Provider value={actions}>
      <ThreadPrimitive.Root className={child ? 'space-y-2' : undefined}>
        <ThreadPrimitive.Messages>{renderMessage}</ThreadPrimitive.Messages>
        {children}
      </ThreadPrimitive.Root>
    </CloudPresentationContext.Provider>
  );
}

export function CloudThread(props: CloudThreadProps) {
  const manager = useOptionalManager();
  return manager ? (
    <CloudThreadWithLiveFacts {...props} manager={manager} />
  ) : (
    <CloudThreadBody {...props} />
  );
}
function CloudThreadWithLiveFacts({
  manager,
  ...props
}: CloudThreadProps & { manager: SessionManager }) {
  const isStreaming = useAtomValue(manager.atoms.isStreaming);
  const activeQuestion = useAtomValue(manager.atoms.activeQuestion);
  const questionState = useMemo(
    () => ({ isStreaming, hasActiveQuestion: activeQuestion !== null }),
    [isStreaming, activeQuestion]
  );
  return <CloudThreadBody {...props} questionState={questionState} />;
}

const rejectReadOnlySend = async () => {
  throw new MessageNotSentError('This transcript is read-only');
};

export function CloudReadOnlyThread({
  messages,
  isStreaming = false,
  messageGroups,
  presentationMode = 'historical',
  ...props
}: CloudThreadProps & {
  messages: readonly StoredMessage[];
  isStreaming?: boolean;
  messageGroups?: readonly (readonly StoredMessage[])[];
}) {
  return (
    <ReadOnlyCloudAgentBoundary>
      <CloudChatRuntimeProvider
        projection={{
          messages,
          isStreaming,
          messageGroups:
            messageGroups ?? (props.child ? messages.map(message => [message]) : undefined),
        }}
        state={{
          isLoading: false,
          isRunning: isStreaming,
          isReadOnly: true,
          isSendDisabled: true,
          canInterrupt: false,
        }}
        onNew={rejectReadOnlySend}
      >
        <CloudThread {...props} presentationMode={presentationMode} />
      </CloudChatRuntimeProvider>
    </ReadOnlyCloudAgentBoundary>
  );
}

/** Optional viewport composition; disable every upstream scrolling trigger. */
export function CloudThreadViewport(props: ComponentProps<typeof ThreadPrimitive.Viewport>) {
  return (
    <ThreadPrimitive.Viewport
      {...props}
      autoScroll={false}
      scrollToBottomOnInitialize={false}
      scrollToBottomOnRunStart={false}
      scrollToBottomOnThreadSwitch={false}
    />
  );
}
