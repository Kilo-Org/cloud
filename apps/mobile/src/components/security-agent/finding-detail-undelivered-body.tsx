import { type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { Skeleton } from '@/components/ui/skeleton';
import { SCREEN_BODY_CLASS } from '@/lib/layout';
import { useSideInsetStyle } from '@/lib/screen-insets';
import { cn } from '@/lib/utils';

/**
 * What the finding detail screen shows while no finding payload is on screen.
 *
 * The four faces share one header with its subtitle line reserved: the payload
 * names the finding's repository on that line, and none of them can be known
 * before the first paint — the first frame is always the loading one — so
 * dropping the line afterwards would pull the title up out of the position the
 * loading frame gave it. `showSubtitlePlaceholder` is the one part that changes:
 * only a read that is still running paints the placeholder bar, so a terminal
 * answer and a failure the retry surface holds keep the same line blank and
 * nothing pulses on a finishable screen.
 */
export type FindingDetailUndelivered =
  | { kind: 'not-found' }
  | { kind: 'failed'; isRetrying: boolean; onRetry: () => void }
  | { kind: 'paused'; isRetrying: boolean; onRetry: () => void }
  | { kind: 'loading' };

type FindingDetailUndeliveredBodyProps = {
  state: FindingDetailUndelivered;
  showSubtitlePlaceholder: boolean;
  onBack: () => void;
};

export function FindingDetailUndeliveredBody({
  state,
  showSubtitlePlaceholder,
  onBack,
}: Readonly<FindingDetailUndeliveredBodyProps>) {
  const { t } = useTranslation();
  const sideInsetStyle = useSideInsetStyle();

  const renderBody = (): ReactElement => {
    if (state.kind === 'not-found') {
      return (
        <QueryError
          variant="not-found"
          title={t('securityAgent.dismiss.notFoundTitle')}
          message={t('securityAgent.dismiss.notFoundDescription')}
        />
      );
    }
    if (state.kind === 'loading') {
      return (
        <View className="flex-1" style={sideInsetStyle}>
          <View className={cn('flex-1', SCREEN_BODY_CLASS)}>
            <Skeleton className="h-6 w-2/3 rounded" />
            <Skeleton className="h-4 w-1/3 rounded" />
            <Skeleton className="h-10 w-full rounded-xl" />
            <Skeleton className="h-40 w-full rounded-xl" />
          </View>
        </View>
      );
    }
    // Both remaining faces are a read with nothing to show, and both offer the
    // retry their caller owns. The paused one names the connection: it is the
    // one a plain `isLoading` gate would leave in the loading frame forever,
    // because a paused read is pending without fetching.
    return (
      <QueryError
        variant={state.kind === 'paused' ? 'offline' : undefined}
        message={t('securityAgent.dismiss.couldNotLoad')}
        onRetry={() => {
          state.onRetry();
        }}
        isRetrying={state.isRetrying}
      />
    );
  };

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title={t('securityAgent.findingDetailScreen.title')}
        reserveSubtitle
        subtitlePlaceholder={
          showSubtitlePlaceholder ? <Skeleton className="h-3.5 w-28 rounded-full" /> : undefined
        }
        showBackButton
        onBack={onBack}
      />
      {renderBody()}
    </View>
  );
}
