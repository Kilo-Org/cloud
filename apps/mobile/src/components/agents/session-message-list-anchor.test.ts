import { describe, expect, it } from 'vitest';

import {
  composerInsetForSession,
  resolveTranscriptFrame,
  resolveTranscriptRideUp,
} from './session-message-list-anchor';

describe('resolveTranscriptRideUp', () => {
  it('keeps the transcript still when the chrome has not grown', () => {
    expect(resolveTranscriptRideUp(0, true)).toBe(0);
  });

  it('rides the transcript up by the growth while it is anchored at its bottom', () => {
    expect(resolveTranscriptRideUp(64, true)).toBe(64);
  });

  it('keeps the transcript still once the reader scrolled away from the bottom', () => {
    expect(resolveTranscriptRideUp(64, false)).toBe(0);
  });

  it('treats a non-finite or shrinking chrome as no growth', () => {
    expect(resolveTranscriptRideUp(Number.NaN, true)).toBe(0);
    expect(resolveTranscriptRideUp(-20, true)).toBe(0);
  });
});

describe('resolveTranscriptFrame', () => {
  it('fills the region exactly when nothing rides up', () => {
    const frame = resolveTranscriptFrame(0);
    expect(frame.holder).toEqual({ flex: 1 });
    expect(frame.content).toBe(frame.holder);
  });

  it('holds the list height and shifts its paint by the growth', () => {
    const frame = resolveTranscriptFrame(64);
    // The holder takes the growth back with a negative margin, so the list
    // keeps the viewport it had before the growth; the shift is a paint offset,
    // which keeps every row's frame, offset and at-bottom verdict.
    expect(frame.holder).toEqual({ flex: 1, overflow: 'hidden', marginBottom: -64 });
    expect(frame.content).toEqual({ flex: 1, transform: [{ translateY: -64 }] });
  });

  it('treats a non-finite or shrinking growth as no growth', () => {
    expect(resolveTranscriptFrame(Number.NaN).holder).toEqual({ flex: 1 });
    expect(resolveTranscriptFrame(-20).holder).toEqual({ flex: 1 });
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
