import { describe, expect, it } from 'vitest';

import {
  APP_SCHEME,
  canonicalSystemSearchId,
  deeplinkPathFromHref,
  FINDING_HREF_PREFIX,
  INDEXED_LINK_PREFIXES,
  isSystemSearchFamilyLink,
  PULL_REQUEST_HREF_PREFIX,
  SESSION_HREF_PREFIX,
} from './system-search-families';

describe('isSystemSearchFamilyLink', () => {
  it('accepts an app-scheme link into each indexed family', () => {
    expect(isSystemSearchFamilyLink('kiloapp://agent-chat/ses_1')).toBe(true);
    expect(isSystemSearchFamilyLink('kiloapp://pr-review/Kilo-Org/cloud/6234')).toBe(true);
    expect(isSystemSearchFamilyLink('kiloapp://security-agent/personal/findings/f_1')).toBe(true);
  });

  it('accepts the triple-slash app-scheme form', () => {
    expect(isSystemSearchFamilyLink('kiloapp:///pr-review/Kilo-Org/cloud/6234')).toBe(true);
  });

  it('rejects an https link and an app-scheme route outside the indexed families', () => {
    expect(isSystemSearchFamilyLink('https://app.kilo.ai/pr-review/Kilo-Org/cloud/6234')).toBe(
      false
    );
    expect(isSystemSearchFamilyLink('kiloapp:///profile')).toBe(false);
    expect(isSystemSearchFamilyLink('kiloapp:///cloud/sessions')).toBe(false);
    expect(isSystemSearchFamilyLink('kiloapp://pr-review')).toBe(false);
    expect(isSystemSearchFamilyLink('')).toBe(false);
  });

  it('derives each indexed link prefix from its href prefix', () => {
    expect(INDEXED_LINK_PREFIXES).toEqual([
      deeplinkPathFromHref(SESSION_HREF_PREFIX),
      deeplinkPathFromHref(PULL_REQUEST_HREF_PREFIX),
      deeplinkPathFromHref(FINDING_HREF_PREFIX),
    ]);
  });

  it('maps an id indexed before a route moved to the current prefix', () => {
    expect(
      canonicalSystemSearchId('/(app)/(tabs)/(3_profile)/security-agent/org-1/findings/f-1')
    ).toBe('/(app)/security-agent/org-1/findings/f-1');
    expect(canonicalSystemSearchId('/(app)/security-agent/personal/findings/f-1')).toBe(
      '/(app)/security-agent/personal/findings/f-1'
    );
    expect(canonicalSystemSearchId('/(app)/agent-chat/ses_1')).toBe('/(app)/agent-chat/ses_1');
  });

  it('names the scheme the indexed links carry', () => {
    expect(APP_SCHEME).toBe('kiloapp://');
  });
});
