import { type StoredMessage } from '@kilocode/cloud-agent-sdk';
import { type ListRenderItem } from '@shopify/flash-list';
import { useTranslation } from 'react-i18next';

import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';
import { MessageCircle } from '@/components/ui/icons';

import { MessageBubble } from './message-bubble';
import { SessionMessageList } from './session-message-list';
import { SessionSkeletonMessages } from './session-detail-skeleton';

/** Same terminal classification `quick-chat-screen` uses for a history read. */
const NON_RETRYABLE_ERROR_CODES = new Set(['NOT_FOUND', 'FORBIDDEN', 'UNAUTHORIZED']);

// Message rows carry no preview state, so the renderer lives at module scope
// and is never recreated per render — the same contract as `quick-chat-screen`.
const renderItem: ListRenderItem<StoredMessage> = ({ item }) => <MessageBubble message={item} />;

/** The preview is read-only: it never pages older history. */
function noopLoadOlderMessages(): void {
  // Intentionally empty — `hasOlderMessages` is false, so the list never calls it.
}

export type SessionPreviewTranscriptState = {
  sessionId: string;
  messages: readonly StoredMessage[];
  isLoading: boolean;
  isError: boolean;
  /** tRPC error code from the failed read; undefined for an unknown failure. */
  errorCode: string | undefined;
  onRetry: () => void;
};

/**
 * The preview's transcript region: the four read states plus loading, each
 * rendered into the space the card already reserved so the swap cannot move
 * the card. There is no composer and no send/stop/queue handler — the card is
 * a viewer.
 */
export function SessionPreviewTranscript({
  sessionId,
  messages,
  isLoading,
  isError,
  errorCode,
  onRetry,
}: Readonly<SessionPreviewTranscriptState>) {
  const { t } = useTranslation();
  const empty = messages.length === 0;

  if (isLoading && empty) {
    // Sized like the rows it replaces, so the swap into content does not move
    // the card.
    return <SessionSkeletonMessages sessionId={sessionId} />;
  }
  if (isError && empty) {
    const nonRetryable = errorCode !== undefined && NON_RETRYABLE_ERROR_CODES.has(errorCode);
    if (nonRetryable) {
      return (
        <QueryError
          variant={errorCode === 'NOT_FOUND' ? 'not-found' : 'permission'}
          placement="static"
          className="w-full"
        />
      );
    }
    return <QueryError variant="server" placement="static" className="w-full" onRetry={onRetry} />;
  }
  if (empty) {
    return (
      <EmptyState
        icon={MessageCircle}
        title={t('agentChat.session.emptyTitle')}
        description={t('agentChat.session.emptyTranscriptDescription')}
        placement="static"
        className="w-full"
      />
    );
  }
  return (
    <SessionMessageList<StoredMessage>
      sessionId={sessionId}
      items={messages}
      keyExtractor={message => message.info.id}
      hasOlderMessages={false}
      isLoadingOlderMessages={false}
      olderMessagesError={null}
      olderMessagesOmittedItemCount={0}
      onLoadOlderMessages={noopLoadOlderMessages}
      renderItem={renderItem}
    />
  );
}
