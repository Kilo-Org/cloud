import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback } from 'react';
import { BackHandler } from 'react-native';

import { MODEL_CATALOG_HREF } from './model-catalog-entry';

/**
 * Back out of a model detail: always the catalog list.
 *
 * `dismissTo` (React Navigation's POP_TO) pops back to the list when the user
 * came from it — the list stays mounted, so its scroll position survives —
 * and puts the list on the stack in its place when the detail was opened
 * without it (a deep link). `router.back()` cannot promise the second shape:
 * it reveals whatever route the stack holds beneath, which is not
 * necessarily the catalog, and the second Back is then the one that gets
 * there.
 */
export function useModelCatalogBack(): () => void {
  const router = useRouter();

  return useCallback(() => {
    router.dismissTo(MODEL_CATALOG_HREF);
  }, [router]);
}

/**
 * The same rule for Android's hardware and gesture Back.
 *
 * Without it the navigator pops the detail to the route beneath — Home, or a
 * session route left over from an earlier flow — instead of the catalog.
 * Returning `true` consumes the event so the navigator does not also pop.
 *
 * Bound to focus, not mount: a stack keeps lower screens mounted, and an
 * unfocused detail that kept its listener would hijack Back on whatever was
 * pushed above it.
 */
export function useModelCatalogHardwareBack(): void {
  const router = useRouter();

  useFocusEffect(
    useCallback(() => {
      const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
        router.dismissTo(MODEL_CATALOG_HREF);
        return true;
      });
      return () => {
        subscription.remove();
      };
    }, [router])
  );
}
