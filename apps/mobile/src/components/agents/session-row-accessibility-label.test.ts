import { describe, expect, it } from 'vitest';

import {
  formatSpokenTimeAgo,
  sessionRowAccessibilityLabel,
} from './session-row-accessibility-label';

/**
 * Feature C — a11y labels mirroring visible content.
 *
 * The three exclusive variants below cover the matrix in plan-k-tray-followups
 * Item 3 / Feature C, matched one-to-one with `selectSessionRowEyebrowRight`.
 *
 * Other feature states (loading, empty, error, retryable/non-retryable
 * failures, CTAs) are structurally n/a for these helpers: they are pure
 * presentation functions for rows that already exist, and rows only exist
 * when their data exists. Coverage for those states lives on the consuming
 * screens (session-list-screen, session-list-content) and is unchanged by
 * this slice.
 */

describe('formatSpokenTimeAgo', () => {
  it('expands "1m ago" to "1 minute ago" (singular minutes)', () => {
    const t = new Date(Date.now() - 60 * 1000).toISOString();
    expect(formatSpokenTimeAgo(t)).toBe('1 minute ago');
  });

  it('expands "5m ago" to "5 minutes ago" (plural minutes)', () => {
    const t = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    expect(formatSpokenTimeAgo(t)).toBe('5 minutes ago');
  });

  it('expands "1h ago" to "1 hour ago" (singular hours)', () => {
    const t = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    expect(formatSpokenTimeAgo(t)).toBe('1 hour ago');
  });

  it('expands "3h ago" to "3 hours ago" (plural hours)', () => {
    const t = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    expect(formatSpokenTimeAgo(t)).toBe('3 hours ago');
  });

  it('expands "1d ago" to "1 day ago" (singular days)', () => {
    const t = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    expect(formatSpokenTimeAgo(t)).toBe('1 day ago');
  });

  it('expands "3d ago" to "3 days ago" (plural days)', () => {
    const t = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    expect(formatSpokenTimeAgo(t)).toBe('3 days ago');
  });

  it('expands "1mo ago" to "1 month ago" (singular months)', () => {
    // 35 days pushes past the 30-day boundary into the months branch
    const t = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString();
    expect(formatSpokenTimeAgo(t)).toBe('1 month ago');
  });

  it('expands "2mo ago" to "2 months ago" (plural months)', () => {
    const t = new Date(Date.now() - 65 * 24 * 60 * 60 * 1000).toISOString();
    expect(formatSpokenTimeAgo(t)).toBe('2 months ago');
  });

  it('expands "1y ago" to "1 year ago" (singular years)', () => {
    // 370 days pushes past the 12-month boundary into the years branch
    const t = new Date(Date.now() - 370 * 24 * 60 * 60 * 1000).toISOString();
    expect(formatSpokenTimeAgo(t)).toBe('1 year ago');
  });

  it('expands "2y ago" to "2 years ago" (plural years)', () => {
    const t = new Date(Date.now() - 2 * 370 * 24 * 60 * 60 * 1000).toISOString();
    expect(formatSpokenTimeAgo(t)).toBe('2 years ago');
  });

  it('leaves "just now" unchanged', () => {
    const t = new Date().toISOString();
    expect(formatSpokenTimeAgo(t)).toBe('just now');
  });
});

describe('sessionRowAccessibilityLabel', () => {
  describe('needs-input variant — StoredSessionRow (meta omitted)', () => {
    it('produces "title, needs input, badge" with meta=null', () => {
      // Stored row, needs-input eyebrow wins: meta is NOT rendered.
      // The caller passes meta=null; the composer skips empty parts.
      expect(
        sessionRowAccessibilityLabel({
          title: 'Fix login bug',
          needsInput: true,
          badge: 'CLI',
          meta: null,
        })
      ).toBe('Fix login bug, needs input, CLI');
    });

    it('includes meta when the caller passes it (caller is responsible for omitting)', () => {
      // The composer is a simple joiner: it includes meta when passed.
      // The row wires meta=null for needs-input rows (see session-row.tsx);
      // if a future caller forgets, the composer does not silently strip
      // meta. This test pins that contract so a "helpful" change here
      // is a deliberate decision, not an accident.
      expect(
        sessionRowAccessibilityLabel({
          title: 'Fix login bug',
          needsInput: true,
          badge: 'VSCODE',
          meta: '5 minutes ago',
        })
      ).toBe('Fix login bug, needs input, VSCODE, 5 minutes ago');
    });
  });

  describe('visible-meta variant — StoredSessionRow ("meta" eyebrow)', () => {
    it('produces "title, badge, meta" with a spoken time', () => {
      // Stored row, meta eyebrow renders the relative time.
      expect(
        sessionRowAccessibilityLabel({
          title: 'Fix login bug',
          needsInput: false,
          badge: 'CLI',
          meta: '5 minutes ago',
        })
      ).toBe('Fix login bug, CLI, 5 minutes ago');
    });

    it('produces "title, badge, meta" with "just now"', () => {
      expect(
        sessionRowAccessibilityLabel({
          title: 'New session',
          needsInput: false,
          badge: 'CLOUD AGENT',
          meta: 'just now',
        })
      ).toBe('New session, CLOUD AGENT, just now');
    });

    it('produces "title, badge, meta" with a days-ago spoken form', () => {
      expect(
        sessionRowAccessibilityLabel({
          title: 'Old session',
          needsInput: false,
          badge: 'SLACK',
          meta: '3 days ago',
        })
      ).toBe('Old session, SLACK, 3 days ago');
    });
  });

  describe('needs-input variant — RemoteSessionRow (meta omitted)', () => {
    it('produces "title, needs input, badge" with meta=null', () => {
      // Remote row, needs-input eyebrow wins: live dot is hidden, meta is
      // hidden. Badge is the left-eyebrow platform label or LIVE fallback.
      expect(
        sessionRowAccessibilityLabel({
          title: 'Live session',
          needsInput: true,
          badge: 'CLI',
          meta: null,
        })
      ).toBe('Live session, needs input, CLI');
    });

    it('works with the LIVE fallback badge', () => {
      expect(
        sessionRowAccessibilityLabel({
          title: 'Live session',
          needsInput: true,
          badge: 'LIVE',
          meta: null,
        })
      ).toBe('Live session, needs input, LIVE');
    });
  });

  describe('visible-meta variant — RemoteSessionRow ("live-and-meta" eyebrow)', () => {
    it('produces "title, badge, meta" with a spoken time', () => {
      // Remote row with updatedAt: live dot + meta render side-by-side.
      expect(
        sessionRowAccessibilityLabel({
          title: 'Live session',
          needsInput: false,
          badge: 'CLI',
          meta: '2 hours ago',
        })
      ).toBe('Live session, CLI, 2 hours ago');
    });
  });

  describe('bare-live variant — RemoteSessionRow ("live" eyebrow, no meta)', () => {
    it('produces "title, badge" with no meta', () => {
      // Remote row: live dot only (no updatedAt to render as meta).
      expect(
        sessionRowAccessibilityLabel({
          title: 'Live session',
          needsInput: false,
          badge: 'LIVE',
          meta: null,
        })
      ).toBe('Live session, LIVE');
    });
  });

  describe('order invariant (title → needs input → badge → meta)', () => {
    it('preserves fixed order with all parts present', () => {
      expect(
        sessionRowAccessibilityLabel({
          title: 'A',
          needsInput: true,
          badge: 'B',
          meta: 'C',
        })
      ).toBe('A, needs input, B, C');
    });

    it('preserves fixed order with needsInput false and no meta', () => {
      expect(
        sessionRowAccessibilityLabel({
          title: 'A',
          needsInput: false,
          badge: 'B',
          meta: null,
        })
      ).toBe('A, B');
    });

    it('preserves fixed order with title and meta only (no badge, no needsInput)', () => {
      // Defensive: badge is always visible per the brief, but if the caller
      // passes an empty string the composer skips it.
      expect(
        sessionRowAccessibilityLabel({
          title: 'Orphan',
          needsInput: false,
          badge: '',
          meta: '1 day ago',
        })
      ).toBe('Orphan, 1 day ago');
    });
  });
});
