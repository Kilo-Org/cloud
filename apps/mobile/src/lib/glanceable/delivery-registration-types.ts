/**
 * The registration record and the token kinds shared by the delivery
 * registration and the activity observation, split out so the two modules can
 * share the type without a cycle.
 */

import { type GlanceableSinkContext } from './sink-registry';

/** Scope delivery survives idle work; only the activity registration ends with its surface. */
export type Registration = GlanceableSinkContext & {
  kind: 'ios_push_to_start' | 'ios_activity' | 'android_ongoing';
  epoch: number;
  authEpoch: number;
  token: string | null;
  registeredToken: string | null;
  tokens: Set<string>;
};

/** The kind the observed Live Activity's own registration carries. */
export const GLANCEABLE_ACTIVITY_TOKEN_KIND = 'ios_activity';
