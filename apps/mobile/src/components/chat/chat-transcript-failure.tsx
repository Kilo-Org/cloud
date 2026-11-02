import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { QueryError } from '@/components/query-error';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { CHAT_UNAVAILABLE_KEY } from '@/lib/chat/state';

type ChatTranscriptFailureProps = Readonly<{
  /** The fixed localization key the chat settled with, never a provider's text. */
  failureKey: string;
  /** Whether entering the chat again could settle something else. */
  retryable: boolean;
  onRetry: () => void;
  onBack: () => void;
}>;

/**
 * The one state a chat that settled with a failure and no transcript shows.
 *
 * Such a chat has nothing to read: its row is not here any more, its backend
 * was deleted, or the open failed. The transcript area draws that failure in
 * the place the empty state would stand, and the composer does not repeat it
 * as a second line — two states on one screen read as a screen that cannot
 * say which applies.
 *
 * Retry is offered only where entering the chat again could settle something
 * else. A chat this place may not read settles the same way every time, so it
 * offers the way back instead.
 */
export function ChatTranscriptFailure({
  failureKey,
  retryable,
  onRetry,
  onBack,
}: Readonly<ChatTranscriptFailureProps>) {
  const { t } = useTranslation();
  const unavailable = failureKey === CHAT_UNAVAILABLE_KEY;

  return (
    <QueryError
      // The chat is gone in the first case and failed in the second, so the
      // title says which of the two the person is looking at.
      variant={unavailable ? 'not-found' : 'neutral'}
      title={unavailable ? undefined : t('common.somethingWentWrong')}
      // A generic failure's own copy is that same title, so it is not printed
      // again below it: the neutral description carries the retry invitation.
      message={failureKey === 'common.somethingWentWrong' ? undefined : t(failureKey)}
      action={
        <View className="flex-row flex-wrap items-center justify-center gap-3">
          {retryable ? (
            <Button variant="outline" className={STATE_ACTION_CLASS} onPress={onRetry}>
              <Text>{t('common.retry')}</Text>
            </Button>
          ) : null}
          <Button variant="ghost" className={STATE_ACTION_CLASS} onPress={onBack}>
            <Text>{t('common.back')}</Text>
          </Button>
        </View>
      }
    />
  );
}
