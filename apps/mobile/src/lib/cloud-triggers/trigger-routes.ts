/**
 * The trigger screens' hrefs, so a screen never spells another's path.
 *
 * The organization travels as the `org` query parameter, the same one the spend
 * alerts and organization screens read: absent means the caller's own triggers.
 */

import type { Href } from 'expo-router';

import { triggerScopeQuery } from './trigger-scope';

const TRIGGERS_ROOT = '/(app)/(tabs)/(3_profile)/triggers';

export function triggersListHref(organizationId?: string): Href {
  return `${TRIGGERS_ROOT}${triggerScopeQuery(organizationId)}` as Href;
}

export function triggerCreateHref(organizationId?: string): Href {
  return `${TRIGGERS_ROOT}/new${triggerScopeQuery(organizationId)}` as Href;
}

export function triggerDetailHref(triggerId: string, organizationId?: string): Href {
  return `${TRIGGERS_ROOT}/${encodeURIComponent(triggerId)}${triggerScopeQuery(organizationId)}` as Href;
}
