import { type Href, useRouter } from 'expo-router';
import { SearchX } from '@/components/ui/icons';
import { useTranslation } from 'react-i18next';

import { EmptyState } from '@/components/empty-state';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';

/**
 * Terminal state for a route whose params fail runtime validation (bad
 * scope/platform/id, or an unsupported scope+platform combination) —
 * matches the "instance not found" pattern in instance-context-boundary.tsx.
 *
 * Back replaces this route with `backTo`, the in-app parent its caller chose.
 * It never pops: a cold deep link renders on top of the tab anchor, so
 * `canGoBack()` is true even though the user has no history here, and popping
 * would leave for Home instead of the surface the link was about.
 */
export function InvalidRouteState({ backTo }: Readonly<{ backTo: Href }>) {
  const router = useRouter();
  const { t } = useTranslation();

  return (
    <EmptyState
      className="bg-background"
      icon={SearchX}
      title={t('invalidRoute.title')}
      description={t('invalidRoute.description')}
      action={
        <Button
          variant="outline"
          onPress={() => {
            router.replace(backTo);
          }}
        >
          <Text>{t('common.goBack')}</Text>
        </Button>
      }
    />
  );
}
