import { router } from 'expo-router';

import { ORGANIZATION_HUB_PATH } from '@/lib/organization-navigation';

/**
 * Development-only entry for the invite member sheet.
 *
 * The invite form is a native formSheet that only the members screen pushes, so
 * a link cannot open it: the resolver lands on the sheet alone, a stack root
 * that presents at the window top instead of over the members screen it belongs
 * to. This fixture therefore walks the reader's own two pushes — members, then
 * the sheet — and reports the link as handled, so `+native-intent.tsx` returns
 * falsy and nothing else resolves it.
 *
 * The link is the app scheme's `dev/organization-invite-member-fixture` path. It
 * needs the signed-in account's selected organization to have a role that may
 * invite; the sheet's boundary and permission states answer otherwise.
 */
const FIXTURE_PATH = /(?:^|\/)dev\/organization-invite-member-fixture\/?(?:[?#].*)?$/;

const MEMBERS_PATH = '/(app)/(tabs)/(3_profile)/organization/members';
const INVITE_MEMBER_PATH = '/(app)/(tabs)/(3_profile)/organization/invite-member';

/**
 * How long the members push needs before the sheet can present over it. The
 * reader's second tap comes after the screen is on glass; a second push in the
 * same turn instead presents the sheet at the window top, a frame the product
 * never shows.
 */
const MEMBERS_PRESENTED_MS = 400;

/**
 * Handle a fixture link. True when the path is this fixture.
 */
export function handleOrganizationInviteMemberFixturePath(path: string): boolean {
  if (!FIXTURE_PATH.test(path)) {
    return false;
  }
  // `router` queues navigation when the router is not mounted yet, so a cold
  // delivery still lands. Same routes, same order as the reader's own taps.
  router.dismissTo(ORGANIZATION_HUB_PATH);
  router.push(MEMBERS_PATH);
  setTimeout(() => {
    router.push(INVITE_MEMBER_PATH);
  }, MEMBERS_PRESENTED_MS);
  return true;
}
