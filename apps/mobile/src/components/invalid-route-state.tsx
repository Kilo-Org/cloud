import { type Href, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { StateAction } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';
import { DirectionalArrowLeft } from '@/components/ui/directional-icons';

/**
 * Terminal state for a route whose params fail runtime validation (bad
 * scope/platform/id, or an unsupported scope+platform combination) —
 * matches the "instance not found" pattern in instance-context-boundary.tsx.
 *
 * It is the app's one not-found face, `QueryError`'s `not-found` variant, with
 * the link's own copy. The route renders no header of its own (it can sit in a
 * page or a sheet), so the state carries the one way out.
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
    <QueryError
      className="bg-background"
      variant="not-found"
      title={t('invalidRoute.title')}
      message={t('invalidRoute.description')}
      action={
        <StateAction
          label={t('common.goBack')}
          icon={DirectionalArrowLeft}
          onPress={() => {
            router.replace(backTo);
          }}
        />
      }
    />
  );
}
