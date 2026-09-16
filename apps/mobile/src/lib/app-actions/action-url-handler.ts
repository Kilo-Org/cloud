// The action URLs ride the deep-link pipeline the app already runs.
//
// `parseAppActionUrl` (the s1 contract) recognises `kiloapp:///actions/<slug>?…`
// and the scheme-less path expo-router hands `redirectSystemPath`. A session and
// a review resolve to an href and are stashed exactly as a universal link is
// (`src/lib/deep-link-handler.ts`); `StartAgent` and `OpenNeedsInput` cannot be
// answered from a URL alone, so they park for the tabs layout, which owns both
// the router and the live session list. A review link the provider resolvers
// cannot turn into a destination parks too: nothing opens, and the tabs layout
// reports the contract's refusal instead of the app arriving unexplained.

import { setPendingDeepLink, wasLaunchLinkHandled } from '@/lib/deep-link-launch';

import { appActionHref, parseAppActionUrl } from './app-action-contract';
import { setPendingAppAction } from './pending-app-action';

/**
 * Take an action URL (or its scheme-less path) in and return whether it was one.
 *
 * `false` means the path is not an action URL and the caller keeps going — the
 * universal-link mapper resolves nothing for these paths and must own the rest.
 * `true` means it belongs to this contract, including a link the provider
 * resolvers cannot turn into a destination: nothing is opened — the request
 * parks for the tabs consumer, which reports the refusal — and the path still
 * must not be mapped as a web route.
 *
 * The stash is the identical call `deep-link-handler.ts:71,76` makes, cold-start
 * guard included: the synchronous launch capture may already have stashed this
 * launch URL, and a second stash would surface as a duplicate navigation. No
 * `DeepLinkSource` is added, so the persisted record schema is untouched.
 */
export function handleAppActionPath({
  path,
  initial,
}: {
  path: string;
  initial: boolean;
}): boolean {
  const request = parseAppActionUrl(path);
  if (request === null) {
    return false;
  }
  if (request.action === 'StartAgent' || request.action === 'OpenNeedsInput') {
    // StartAgent has to run, and OpenNeedsInput answers from the live session
    // list: neither is a destination a URL can name. Park for the consumer.
    setPendingAppAction(request);
    return true;
  }
  const resolved = appActionHref(request);
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- boundary: an `Href` union enters a store that holds strings
  if (typeof resolved !== 'string') {
    // In practice only a review link the provider resolvers do not recognize
    // reaches here: the contract's builders return string paths. It still
    // belongs to the contract, so park it for the tabs consumer — dropping it
    // silently would bring the app to the front with nothing opened and
    // nothing reported.
    setPendingAppAction(request);
    return true;
  }
  if (initial ? !wasLaunchLinkHandled() : true) {
    setPendingDeepLink(resolved, 'universal-link');
  }
  return true;
}
