import { type Href } from 'expo-router';

/**
 * The provider-neutral PR Review inbox: the parent surface of every PR-review
 * detail route, and the one in-app destination every detail screen's Back can
 * always name.
 *
 * `dismissTo` (React Navigation's POP_TO) pops back to it when it is already
 * on the stack, and replaces the detail screen with it otherwise. A cold deep
 * link renders the detail on top of the tab anchor only, so `router.back()`
 * would leave the surface for Home; dismissing to the inbox keeps Back inside
 * PR review in both shapes.
 */
export const PR_REVIEW_ENTRY_HREF: Href = '/(app)/pr-review';
