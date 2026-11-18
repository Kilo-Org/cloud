import { type Href } from 'expo-router';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { InvalidRouteState } from '@/components/invalid-route-state';
import { QueryError } from '@/components/query-error';
import { ReviewerHeader } from '@/components/code-reviewer/reviewer-header';
import { Text } from '@/components/ui/text';
import { ChoiceRow } from '@/components/ui/choice-row';
import { TabScreenScrollView } from '@/components/tab-screen';
import { REVIEW_FOCUS_AREAS, type ReviewerPlatform } from '@/lib/code-reviewer-config';
import {
  useReviewConfig,
  useReviewConfigCacheReader,
  useSaveReviewConfig,
} from '@/lib/hooks/use-code-reviewer';
import { reviewConfigFailure, useReviewConfigBody } from '@/lib/hooks/use-review-config-body';
import { useReviewerRouteParams } from '@/lib/hooks/use-reviewer-route-params';

export default function FocusAreasRoute() {
  const params = useReviewerRouteParams();
  if (!params) {
    return <InvalidRouteState backTo={'/(app)/code-reviewer' as Href} />;
  }
  return <FocusAreasScreen scope={params.scope} platform={params.platform} />;
}

function FocusAreasScreen({
  scope,
  platform,
}: Readonly<{ scope: string; platform: ReviewerPlatform }>) {
  const config = useReviewConfig(scope, platform);
  const configBody = useReviewConfigBody(config);
  const { data } = config;
  const failure = reviewConfigFailure(configBody, config.isFetching);
  const save = useSaveReviewConfig(scope, platform);
  const readConfig = useReviewConfigCacheReader(scope, platform);
  const selected = data?.focusAreas ?? [];
  const disabled = configBody.body.status !== 'ready';
  const { t } = useTranslation();
  const areaLabels = {
    security: 'codeReviewer.focusArea.security',
    performance: 'common.performance',
    bugs: 'codeReviewer.focusArea.bugs',
    style: 'codeReviewer.focusArea.style',
    testing: 'codeReviewer.focusArea.testing',
    documentation: 'codeReviewer.focusArea.documentation',
  } as const;

  // A stored area outside REVIEW_FOCUS_AREAS has no enum row of its own; show
  // each distinct one with the localized fallback label so the user can see
  // and unselect it instead of it silently persisting.
  const unknownAreas = [
    ...new Set(selected.filter(area => !(REVIEW_FOCUS_AREAS as readonly string[]).includes(area))),
  ];

  const toggleArea = (area: string) => {
    // Read the cache at call time, not the render-time snapshot above, so
    // two rapid taps each build the next array from the latest committed
    // selection instead of dropping one another.
    const current = readConfig()?.focusAreas ?? [];
    const next = current.includes(area)
      ? current.filter(item => item !== area)
      : [...current, area];
    save.mutate({ focusAreas: next });
  };

  return (
    <View className="flex-1 bg-background">
      <ReviewerHeader title={t('codeReviewer.focusAreas.title')} />
      {failure ? (
        // A config read that failed, or one that stayed pending with nothing
        // in flight even after its automatic restart, would otherwise leave
        // every row disabled with no explanation and no action that resolves
        // it.
        <QueryError
          variant={failure.variant}
          onRetry={() => {
            failure.onRetry();
          }}
          isRetrying={failure.isRetrying}
        />
      ) : (
        <TabScreenScrollView className="flex-1" contentContainerClassName="px-6 pt-4">
          <Text variant="muted" className="mb-2 text-xs">
            {t('codeReviewer.focusAreas.hint')}
          </Text>
          {REVIEW_FOCUS_AREAS.map(area => (
            <ChoiceRow
              key={area}
              label={t(areaLabels[area])}
              multi
              selected={selected.includes(area)}
              disabled={disabled}
              className="border-b-[0.5px] border-hair-soft"
              onPress={() => {
                toggleArea(area);
              }}
            />
          ))}
          {unknownAreas.map(area => (
            <ChoiceRow
              key={area}
              label={t('codeReviewer.focusArea.unknown', { area })}
              multi
              selected
              disabled={disabled}
              className="border-b-[0.5px] border-hair-soft"
              onPress={() => {
                toggleArea(area);
              }}
            />
          ))}
        </TabScreenScrollView>
      )}
    </View>
  );
}
