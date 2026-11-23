import { type ReactNode, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import {
  type ChildSessionHydrationState,
  type OlderMessagesError,
  type SessionSnapshotFailureKind,
  type StoredMessage,
} from '@kilocode/cloud-agent-sdk';

import { CenteredState } from '@/components/centered-state';
import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';
import { SheetHeader } from '@/components/sheet-header';
import { Button } from '@/components/ui/button';
import { Bot } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { type SessionModelOption } from '@/lib/hooks/use-session-model-options';

import {
  ChildSessionMessage,
  type OpenChildSession,
  type RenderPartFn,
} from './child-session-section';
import { describeChildHistoryFailure } from './child-session-history-failure';
import { getChildSessionModelLabel } from './child-session-model';
import { ChildSessionModelLabel } from './child-session-model-label';
import { MessageErrorBoundary } from './message-error-boundary';
import { partRendersContent } from './message-visibility';
import { PartDetailSheetHost } from './part-detail-sheet-host';
import { getChildSessionSheetState } from './child-session-sheet-state';
import { SessionMessageList } from './session-message-list';
import { SessionPageSheet } from './session-page-sheet';
import { SessionStatusIndicator } from './session-status-indicator';
import { describeSessionRuntimeFailure } from './session-terminal-error';
import { buildTerminalErrorCopyText } from './terminal-error-copy-text';
import { performCopy } from './use-message-copy';
import { WorkingIndicator } from './working-indicator';

type ChildSessionSheetProps = {
  visible: boolean;
  sessionId: string;
  title: string;
  getChildMessages: (sessionId: string) => StoredMessage[];
  /**
   * Resolves the messages that derive status indicators: the footer
   * working-indicator label and the nested task cards' activity label.
   * Defaults to `getChildMessages`. The session page passes the raw transcript
   * here so hiding thinking rows never changes "Thinking".
   */
  getIndicatorMessages?: (sessionId: string) => StoredMessage[];
  hydrationState: ChildSessionHydrationState;
  sessionError: string | null;
  isStreaming: boolean;
  hasOlderMessages: boolean;
  isLoadingOlderMessages: boolean;
  olderMessagesError: OlderMessagesError | null;
  olderMessagesOmittedItemCount: number;
  onLoadOlderMessages: () => void;
  renderPart: RenderPartFn;
  onOpenChildSession: OpenChildSession;
  onRetry: () => void;
  onClose: () => void;
  /** Fires on iOS after the native pageSheet dismiss animation completes. */
  onDismiss?: () => void;
  modelOptions?: SessionModelOption[];
};

/**
 * Cadence for re-issuing a child's failed first-page load while the sheet
 * holds the loading state for a streaming child. The child is live, so its
 * first-page failure is transient; without the retry the sheet would spin on
 * "Loading subagent session" forever and the rows a later fetch returns would
 * never land.
 */
export const HELD_CHILD_LOAD_RETRY_MS = 2000;

export function ChildSessionSheet({
  visible,
  sessionId,
  title,
  getChildMessages,
  getIndicatorMessages = getChildMessages,
  hydrationState,
  sessionError,
  isStreaming,
  hasOlderMessages,
  isLoadingOlderMessages,
  olderMessagesError,
  olderMessagesOmittedItemCount,
  onLoadOlderMessages,
  renderPart,
  onOpenChildSession,
  onRetry,
  onClose,
  onDismiss,
  modelOptions,
}: Readonly<ChildSessionSheetProps>) {
  const messages = getChildMessages(sessionId);
  const indicatorMessages = getIndicatorMessages(sessionId);
  // A reasoning-only message keeps its place in `messages` so the sheet stays in
  // the content state and the footer spinner reads "Thinking", but it renders no
  // row. Drop it from the list so its padded wrapper cannot leave an empty row.
  const rowMessages = messages.filter(message => message.parts.some(partRendersContent));
  const sheetState = getChildSessionSheetState(hydrationState, messages.length, sessionError);
  const { t } = useTranslation();
  // Hydration drops its error while retrying. Retain this child's failure —
  // its message and its typed kind — so the copy and the recovery controls do
  // not change character until the request settles.
  const [lastHydrationError, setLastHydrationError] = useState<{
    sessionId: string;
    kind: SessionSnapshotFailureKind | null;
    message: string | null;
  }>({ sessionId, kind: null, message: null });
  let retainedHydrationError: { kind: SessionSnapshotFailureKind | null; message: string } | null =
    null;
  if (hydrationState.status === 'error') {
    retainedHydrationError = { kind: hydrationState.kind, message: hydrationState.message };
  } else if (
    hydrationState.status === 'loading' &&
    lastHydrationError.sessionId === sessionId &&
    lastHydrationError.message !== null
  ) {
    retainedHydrationError = { kind: lastHydrationError.kind, message: lastHydrationError.message };
  }
  const hydrationError = retainedHydrationError?.message ?? null;
  if (
    lastHydrationError.sessionId !== sessionId ||
    lastHydrationError.message !== hydrationError ||
    lastHydrationError.kind !== (retainedHydrationError?.kind ?? null)
  ) {
    setLastHydrationError({
      sessionId,
      kind: retainedHydrationError?.kind ?? null,
      message: hydrationError,
    });
  }
  // The hydration error is a raw SDK string with a typed failure kind. Describe
  // it so the reader sees catalog copy, and offer Retry only where one can
  // help. A blank message stays undefined so `QueryError` falls back to its
  // variant copy.
  const describedHydrationError =
    retainedHydrationError === null || retainedHydrationError.message === ''
      ? null
      : describeChildHistoryFailure(retainedHydrationError);
  // A streaming child is proof the session is live: its first rows are in
  // flight, so a first-page failure a retry can recover must not render — not
  // as the banner above rows (guarded below) and not full-screen before the
  // first row lands. Hold the loading state and re-issue the load below, so the
  // rows land when the fetch recovers. A terminal kind (an oversize or
  // unreadable stored page) is not held: the same read answers the same way
  // every time, so its card states the reason while the child streams.
  const state =
    sheetState === 'error' &&
    isStreaming &&
    hydrationState.status === 'error' &&
    describedHydrationError?.retryable === true
      ? 'loading'
      : sheetState;
  // The held loading state only resolves when the first page lands. A stream
  // event clears the stored error, but a dropped connection delivers no event
  // while the child keeps running, so the sheet must re-issue the load itself.
  // Retry on a cadence while the sheet is visible; the effect stops the moment
  // the state leaves the held loading state (the load succeeds, a row lands,
  // or the child stops streaming). Only a recoverable failure is re-issued.
  const heldFailedLoad =
    state === 'loading' &&
    hydrationState.status === 'error' &&
    describedHydrationError?.retryable === true &&
    visible;
  const onRetryRef = useRef(onRetry);
  useEffect(() => {
    onRetryRef.current = onRetry;
  }, [onRetry]);
  useEffect(() => {
    if (!heldFailedLoad) {
      return undefined;
    }
    const timer = setTimeout(() => {
      onRetryRef.current();
    }, HELD_CHILD_LOAD_RETRY_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [heldFailedLoad]);
  const modelLabel = getChildSessionModelLabel(messages, modelOptions ?? []);
  // The runtime error is a failed agent run, not a failed first-page load, so
  // it resolves through the same copy the transcript's error banner shows
  // rather than the hydration classifier's page-load fallback.
  const describedSessionError =
    sessionError === null || sessionError === ''
      ? null
      : describeSessionRuntimeFailure(sessionError);
  // Copy carries the untranslated original, as the parent terminal error does.
  const copySessionErrorDetails = () => {
    if (describedSessionError === null) {
      return;
    }
    void performCopy(
      buildTerminalErrorCopyText({
        sessionId,
        title: t('agentChat.childSessionSheet.failed'),
        message: describedSessionError.message,
        detail: describedSessionError.detail,
      })
    );
  };
  // Safe-area context can return 0 inside a RN `Modal` (pageSheet doesn't
  // always propagate the home-indicator inset), so we floor the value with
  // a comfortable constant to keep the last row / working indicator clear
  // of the home indicator on curved-bottom devices.
  const insets = useSafeAreaInsets();
  const sheetBottomInset = Math.max(insets.bottom, 16);
  let content: ReactNode = null;

  if (state === 'content') {
    content = (
      <View className="flex-1">
        {sessionError ? (
          <SessionStatusIndicator
            indicator={{ type: 'error', message: sessionError, timestamp: 0 }}
          />
        ) : null}
        {hydrationError !== null && !isStreaming ? (
          // A streaming child is proof the session loaded; its rows are the
          // live truth, so a stale first-page load failure must not sit above
          // them. The manager drops the stored error on the next child chat
          // event; this guard covers the gap before that event arrives.
          <QueryError
            title={t('agentChat.childSessionSheet.couldNotLoad')}
            message={describedHydrationError?.message}
            onRetry={describedHydrationError?.retryable ? onRetry : undefined}
            isRetrying={hydrationState.status === 'loading'}
            placement="top"
            inset="gutter"
            className="gap-3 border-b-[0.5px] border-hair-soft py-3"
          />
        ) : null}
        <SessionMessageList
          sessionId={sessionId}
          items={rowMessages}
          keyExtractor={message => message.info.id}
          hasOlderMessages={hasOlderMessages}
          isLoadingOlderMessages={isLoadingOlderMessages}
          olderMessagesError={olderMessagesError}
          olderMessagesOmittedItemCount={olderMessagesOmittedItemCount}
          onLoadOlderMessages={onLoadOlderMessages}
          renderItem={({ item }) => (
            <MessageErrorBoundary>
              <View className="px-4 py-1">
                <ChildSessionMessage
                  message={item}
                  isStreaming={isStreaming}
                  depth={0}
                  // Nested task cards are status indicators too: resolve their
                  // activity from the raw list so a reasoning stream reads
                  // "Thinking" instead of a stale activity.
                  getChildMessages={getIndicatorMessages}
                  renderPart={renderPart}
                  onOpenChildSession={onOpenChildSession}
                  modelOptions={modelOptions}
                />
              </View>
            </MessageErrorBoundary>
          )}
          ListFooterComponent={
            <WorkingIndicator messages={indicatorMessages} isStreaming={isStreaming} />
          }
          contentBottomInset={sheetBottomInset}
        />
      </View>
    );
  } else if (state === 'error') {
    content =
      hydrationState.status === 'error' ? (
        <QueryError
          title={t('agentChat.childSessionSheet.couldNotLoad')}
          message={describedHydrationError?.message}
          onRetry={describedHydrationError?.retryable ? onRetry : undefined}
        />
      ) : (
        // The child's runtime error is not a failed first-page load, so a
        // hydration Retry cannot recover it (the manager clears this error only
        // when the session switches). Mirror the parent terminal error: the
        // runtime copy with its untranslated original behind Copy, and no CTA.
        <CenteredState>
          <View className="items-center gap-3 px-4">
            <QueryError
              placement="top"
              className="pt-0"
              title={t('agentChat.childSessionSheet.failed')}
              message={describedSessionError?.message}
            />
            <Button
              variant="ghost"
              accessibilityLabel={t('agentChat.session.copyErrorDetails')}
              onPress={copySessionErrorDetails}
            >
              <Text>{t('common.copy')}</Text>
            </Button>
          </View>
        </CenteredState>
      );
  } else if (state === 'empty') {
    content = (
      <EmptyState
        icon={Bot}
        title={t('agentChat.childSessionSheet.noMessages')}
        description={t('agentChat.childSessionSheet.noMessagesDescription')}
      />
    );
  } else {
    content = (
      <EmptyState
        icon={Bot}
        title={t('agentChat.childSessionSheet.loading')}
        description={t('agentChat.childSessionSheet.loadingDescription')}
      />
    );
  }

  return (
    <SessionPageSheet visible={visible} onClose={onClose} onDismiss={onDismiss} dismissible>
      <SheetHeader title={title} onDone={onClose} topInset="ios-page-sheet" />
      {modelLabel ? (
        <View className="border-b-[0.5px] border-hair-soft px-4 py-2">
          <ChildSessionModelLabel modelLabel={modelLabel} />
        </View>
      ) : null}
      <PartDetailSheetHost messages={messages}>{content}</PartDetailSheetHost>
    </SessionPageSheet>
  );
}
