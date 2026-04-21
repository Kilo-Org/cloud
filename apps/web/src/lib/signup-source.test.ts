/**
 * Unit tests for the signup-source parsing helper. Pins the monetary
 * attribution decision: which callback paths qualify a signup for the
 * OpenClaw Security Advisor product-specific bonus, and which don't.
 *
 * Added after the post-merge review on PR #2622 flagged that bonus
 * attribution was reachable without a valid device-auth code.
 */

import { isOpenclawAdvisorCallback } from './signup-source';

describe('isOpenclawAdvisorCallback', () => {
  describe('positive cases — attributes to the advisor', () => {
    it('matches /openclaw-advisor with a well-formed code query', () => {
      expect(isOpenclawAdvisorCallback('/openclaw-advisor?code=ABCD-1234')).toBe(true);
    });

    it('matches a shorter but valid device-auth code', () => {
      expect(isOpenclawAdvisorCallback('/openclaw-advisor?code=A1')).toBe(true);
    });

    it('matches when additional query params follow the code', () => {
      // The helper only checks for a valid `code` param; extra params like
      // utm tags or state are allowed to pass through.
      expect(isOpenclawAdvisorCallback('/openclaw-advisor?code=ABCD-1234&utm_source=plugin')).toBe(
        true
      );
    });

    it('matches when the code param is not first in the query string', () => {
      expect(isOpenclawAdvisorCallback('/openclaw-advisor?utm_source=plugin&code=ABCD-1234')).toBe(
        true
      );
    });
  });

  describe('negative cases — must not attribute', () => {
    it('rejects null callbackPath', () => {
      expect(isOpenclawAdvisorCallback(null)).toBe(false);
    });

    it('rejects undefined callbackPath', () => {
      expect(isOpenclawAdvisorCallback(undefined)).toBe(false);
    });

    it('rejects empty string', () => {
      expect(isOpenclawAdvisorCallback('')).toBe(false);
    });

    it('rejects bare /openclaw-advisor with no query', () => {
      // This was the post-merge-review blocker: a no-code callback
      // previously granted the signup bonus via the old pathname-only
      // check. Now the `code` query param is required.
      expect(isOpenclawAdvisorCallback('/openclaw-advisor')).toBe(false);
    });

    it('rejects /openclaw-advisor with empty code value', () => {
      expect(isOpenclawAdvisorCallback('/openclaw-advisor?code=')).toBe(false);
    });

    it('rejects /openclaw-advisor with malformed code (invalid chars)', () => {
      // `.` and `_` survive URL parsing but are outside the device-auth
      // charset `[A-Za-z0-9-]`. `#` would be stripped into the fragment
      // before searchParams.get sees the code, so it's not a useful probe.
      expect(isOpenclawAdvisorCallback('/openclaw-advisor?code=ab.cd')).toBe(false);
      expect(isOpenclawAdvisorCallback('/openclaw-advisor?code=ab_cd')).toBe(false);
    });

    it('rejects /openclaw-advisor with code longer than 16 chars', () => {
      expect(isOpenclawAdvisorCallback('/openclaw-advisor?code=ABCDEFGHIJKLMNOPQ')).toBe(false);
    });

    it('rejects the sibling path /openclaw-advisor-fake even with a valid code', () => {
      // Defense against the naive-prefix-match bug the post-merge review
      // also called out for the analytics resolver. Exact-pathname match
      // only — a sibling path that shares the prefix must not qualify.
      expect(isOpenclawAdvisorCallback('/openclaw-advisor-fake?code=ABCD-1234')).toBe(false);
    });

    it('rejects /openclaw-advisory (typo-sibling) even with a valid code', () => {
      expect(isOpenclawAdvisorCallback('/openclaw-advisory?code=ABCD-1234')).toBe(false);
    });

    it('rejects a generic device-auth callback', () => {
      expect(isOpenclawAdvisorCallback('/device-auth?code=ABCD-1234')).toBe(false);
    });

    it('rejects other product entry points', () => {
      expect(isOpenclawAdvisorCallback('/claw?code=ABCD-1234')).toBe(false);
      expect(isOpenclawAdvisorCallback('/cloud?code=ABCD-1234')).toBe(false);
      expect(isOpenclawAdvisorCallback('/install?code=ABCD-1234')).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('accepts a trailing slash on /openclaw-advisor/', () => {
      // The pathname regex permits a trailing `/` before the query.
      // With a valid code the attribution should still fire.
      expect(isOpenclawAdvisorCallback('/openclaw-advisor/?code=ABCD-1234')).toBe(true);
    });

    it('rejects the openclaw-advisor path when a fragment carries the code', () => {
      // The device-auth flow never uses URL fragments for the code.
      // Fragments also aren't sent to the server, so they can't survive
      // a round-trip through sign-in anyway. Explicit about this for
      // anyone who wonders later.
      expect(isOpenclawAdvisorCallback('/openclaw-advisor#code=ABCD-1234')).toBe(false);
    });
  });
});
