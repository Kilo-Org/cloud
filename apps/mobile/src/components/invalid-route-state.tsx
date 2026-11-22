import { type Href } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { StateAction } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';
import { DirectionalArrowLeft } from '@/components/ui/directional-icons';
import { useStackSafeReplace } from '@/lib/navigation/stack-safe-replace';

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
 *
 * The swap goes through `useStackSafeReplace`, which pushes and retires this
 * route once that push's transition ends. A caller whose navigator emits no
 * transition event — the root `Slot` route, where the retire could never run
 * and the dead route would stay beneath the destination — passes the plain
 * router instead.
 */
export function InvalidRouteState({
  backTo,
  replace,
}: Readonly<{
  backTo: Href;
  /**
   * The swap to use instead of the stack-safe one, for a caller whose navigator
   * emits no transition event. `+not-found` runs under the root `Slot`, which
   * never retires a source.
   */
  replace?: (href: Href) => void;
}>) {
  const stackSafeRouter = useStackSafeReplace();
  const leave = replace ?? stackSafeRouter.replace;
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
            // Swapping this terminal route for its parent in one commit crashes
            // Android Fabric, so it pushes then retires.
            leave(backTo);
          }}
        />
      }
    />
  );
}
