import { type Href } from 'expo-router';

/**
 * The Profile tab's root route: the first screen of the tab's Stack, and the
 * destination a header's Back lands on when a screen in that tab opens with no
 * history to pop, as a restored route can.
 */
export const PROFILE_TAB_HREF = '/(app)/(tabs)/(3_profile)' as Href;
