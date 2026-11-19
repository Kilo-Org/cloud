import { type Href } from 'expo-router';

/**
 * The Profile tab's root route: the first screen of the tab's Stack, and the
 * destination a header's Back lands on when a screen in that tab opens with no
 * history to pop, as a restored route can.
 */
export const PROFILE_TAB_HREF = '/(app)/(tabs)/(3_profile)' as Href;

/**
 * The personal credit-history screen in the Profile tab's Stack: where a store
 * purchase's receipt lives, for callers that route to it (`credits-links`, the
 * personal invoices empty state).
 */
export const CREDIT_HISTORY_HREF =
  '/(app)/(tabs)/(3_profile)/credit-history' as Href;
