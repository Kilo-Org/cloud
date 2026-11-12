import { describe, expect, it } from 'vitest';

import { composerInsetForSession, resolveTranscriptRideUp } from './session-message-list-anchor';

describe('resolveTranscriptRideUp', () => {
  it('keeps the transcript still when the chrome has not grown', () => {
    expect(resolveTranscriptRideUp(0, true)).toBe(0);
  });

  it('shifts the transcript by the growth while it is anchored at its bottom', () => {
    // The shift is the paint offset the list applies to its content, so the
    // newest row keeps the chrome's top edge without moving any row's frame.
    expect(resolveTranscriptRideUp(64, true)).toBe(64);
  });

  it('keeps the transcript still once the reader scrolled away from the bottom', () => {
    // A shift while the reader is above the tail would hide the top rows of the
    // window they are reading, and only a scroll back down would restore them.
    expect(resolveTranscriptRideUp(64, false)).toBe(0);
  });

  it('treats a non-finite or shrinking chrome as no growth', () => {
    expect(resolveTranscriptRideUp(Number.NaN, true)).toBe(0);
    expect(resolveTranscriptRideUp(-20, true)).toBe(0);
  });
});

describe('composerInsetForSession', () => {
  it('reserves the growth a session measured for itself', () => {
    expect(composerInsetForSession({ sessionId: 'ses-a', dp: 64 }, 'ses-a')).toBe(64);
  });

  it('reserves nothing from another session', () => {
    // The next session's composer publishes its own floor on mount; until that
    // publish lands, a carried-over value would offset its transcript.
    expect(composerInsetForSession({ sessionId: 'ses-a', dp: 64 }, 'ses-b')).toBe(0);
  });
});
