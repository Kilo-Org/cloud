import { type Href, useRouter } from 'expo-router';
import { useMemo } from 'react';

import { type ChatPlace } from '@/lib/chat/scope';
import {
  type AddCreditsDestination,
  addCreditsDestinationOf,
} from '@/lib/credits/add-credits-destination';

/**
 * Where the account buys the credit a refused send needs.
 *
 * The chat's place names the balance its sends draw on, so an organization's
 * chat is settled on that organization's own page and a person's chat on the
 * in-app purchase screen. A place that is not resolved yet names no payer, so
 * the failure draws no action rather than guessing the person's own.
 */
export function useChatAddCredits(place: ChatPlace | null): AddCreditsDestination | undefined {
  const router = useRouter();
  return useMemo(
    () =>
      addCreditsDestinationOf(place, () => {
        router.push('/(app)/credits' as Href);
      }),
    [place, router]
  );
}
