import { describe, expect, it } from 'vitest';

import {
  getOlderMessagesArrivedAnnouncement,
  shouldAnnounceOlderMessagesArrival,
} from '@/components/agents/older-messages-a11y';

describe('shouldAnnounceOlderMessagesArrival', () => {
  it('does not announce on the initial paint (list first becomes initialized)', () => {
    expect(
      shouldAnnounceOlderMessagesArrival({
        wasInitialized: false,
        previousCount: 0,
        nextCount: 20,
        previousNewestKey: null,
        nextNewestKey: 'newest',
      })
    ).toBe(false);
  });

  it('announces when count grows and the newest key stays stable (older page prepend)', () => {
    expect(
      shouldAnnounceOlderMessagesArrival({
        wasInitialized: true,
        previousCount: 20,
        nextCount: 40,
        previousNewestKey: 'newest',
        nextNewestKey: 'newest',
      })
    ).toBe(true);
  });

  it('does not announce on append when the newest key changes', () => {
    expect(
      shouldAnnounceOlderMessagesArrival({
        wasInitialized: true,
        previousCount: 20,
        nextCount: 21,
        previousNewestKey: 'old-newest',
        nextNewestKey: 'new-newest',
      })
    ).toBe(false);
  });

  it('does not announce when a fetch completes with zero prepended items', () => {
    expect(
      shouldAnnounceOlderMessagesArrival({
        wasInitialized: true,
        previousCount: 20,
        nextCount: 20,
        previousNewestKey: 'newest',
        nextNewestKey: 'newest',
      })
    ).toBe(false);
  });

  it('does not announce when count shrinks', () => {
    expect(
      shouldAnnounceOlderMessagesArrival({
        wasInitialized: true,
        previousCount: 20,
        nextCount: 10,
        previousNewestKey: 'newest',
        nextNewestKey: 'newest',
      })
    ).toBe(false);
  });

  it('does not announce when newest keys are missing', () => {
    expect(
      shouldAnnounceOlderMessagesArrival({
        wasInitialized: true,
        previousCount: 0,
        nextCount: 5,
        previousNewestKey: null,
        nextNewestKey: 'newest',
      })
    ).toBe(false);
  });
});

describe('getOlderMessagesArrivedAnnouncement', () => {
  it('is stable screen-reader copy for both message lists', () => {
    expect(getOlderMessagesArrivedAnnouncement()).toBe('Earlier messages loaded');
  });
});
