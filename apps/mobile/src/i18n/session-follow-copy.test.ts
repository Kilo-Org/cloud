import { describe, expect, it } from 'vitest';

import { CATALOG_LOADERS } from './catalogs';
import { SUPPORTED_LANGUAGES, type SupportedLanguage } from './languages';

/**
 * The per-session Follow control is shared by both platforms
 * (`components/agents/session-follow-button.tsx`): iOS starts a Lock Screen Live
 * Activity, Android an ongoing notification. Its copy therefore cannot name
 * either surface, because the label is wrong on the platform it does not name.
 * Copy is authored in `en.json` and translated from it, so a catalog only names
 * a surface when English did.
 *
 * The catalogs already carry one deliberate pair of surface-specific twins,
 * `notifications.liveActivitySubtitle` (iOS) and `notifications.liveUpdateSubtitle`
 * (Android). Whatever the two sentences do not share is this catalog's name for
 * the iOS surface, and no follow label may repeat it. Words both sentences use
 * are dropped, so only the surface name carries over when the surrounding
 * phrasing is translated differently. Deriving the terms from the catalogs
 * keeps the check language-agnostic: there is no glossary to maintain, and a
 * catalog that renames the surface keeps the guard working.
 */
const FOLLOW_LABEL_KEYS = [
  'agentChat.session.follow',
  'agentChat.session.unfollow',
  'glanceable.followFailed',
] as const;

/** Shorter fragments are single letters or case particles in most scripts. */
const SHORTEST_SURFACE_WORD = 4;

function catalogValue(tag: SupportedLanguage, key: string): string | undefined {
  let node: unknown = CATALOG_LOADERS[tag]();
  for (const part of key.split('.')) {
    if (typeof node !== 'object' || node === null) {
      return undefined;
    }
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' ? node : undefined;
}

function sharedPrefixLength(left: string, right: string): number {
  let shared = 0;
  while (shared < left.length && left[shared] === right[shared]) {
    shared += 1;
  }
  return shared;
}

function sharedSuffixLength(left: string, right: string): number {
  let shared = 0;
  while (
    shared < left.length &&
    shared < right.length &&
    left[left.length - 1 - shared] === right[right.length - 1 - shared]
  ) {
    shared += 1;
  }
  return shared;
}

function trimEdges(value: string): string {
  return value.replaceAll(/^[\s.,:;]+|[\s.,:;]+$/g, '');
}

/**
 * The part of the Lock Screen sentence the notifications sentence does not
 * share, as the whole fragment and as each of its words the notifications
 * sentence does not already use.
 */
function surfaceTerms(tag: SupportedLanguage): string[] {
  const lockScreen = catalogValue(tag, 'notifications.liveActivitySubtitle')?.toLocaleLowerCase();
  const notifications = catalogValue(tag, 'notifications.liveUpdateSubtitle')?.toLocaleLowerCase();
  if (!lockScreen || !notifications) {
    return [];
  }
  const prefix = sharedPrefixLength(lockScreen, notifications);
  const suffix = sharedSuffixLength(lockScreen, notifications);
  const fragment = trimEdges(lockScreen.slice(prefix, lockScreen.length - suffix));
  if (!fragment) {
    return [];
  }
  const notificationsWords = new Set(notifications.split(/\s+/).map(word => trimEdges(word)));
  const words = fragment
    .split(/\s+/)
    .map(word => trimEdges(word))
    .filter(word => word.length >= SHORTEST_SURFACE_WORD && !notificationsWords.has(word));
  return [...new Set([fragment, ...words])];
}

/** The follow labels that name a surface, as `<key> repeats "<term>"`. */
function labelledSurfaces(tag: SupportedLanguage): string[] {
  const terms = surfaceTerms(tag);
  return FOLLOW_LABEL_KEYS.flatMap(key => {
    const value = catalogValue(tag, key)?.toLocaleLowerCase();
    const term =
      value === undefined ? undefined : terms.find(candidate => value.includes(candidate));
    return term === undefined ? [] : [`${key} repeats "${term}"`];
  });
}

describe('session follow labels', () => {
  it('defines every follow label in English without naming a card surface', () => {
    for (const key of FOLLOW_LABEL_KEYS) {
      expect(catalogValue('en', key), `en.json is missing ${key}`).toBeTruthy();
    }
    expect(labelledSurfaces('en')).toEqual([]);
  });

  it.each(SUPPORTED_LANGUAGES)('derives the surface name %s uses', tag => {
    expect(
      surfaceTerms(tag),
      `${tag} lost the pair of platform sentences the surface name comes from`
    ).not.toEqual([]);
  });

  it.each(SUPPORTED_LANGUAGES)('%s names no card surface in its follow labels', tag => {
    expect(labelledSurfaces(tag)).toEqual([]);
  });
});
