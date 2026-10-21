import { describe, expect, it } from '@jest/globals';
import {
  resolveTranscriptPhase,
  transcriptReadyForEffects,
  type ResolveTranscriptPhaseInput,
} from './transcript-switch';

const base: ResolveTranscriptPhaseInput = {
  requestedSessionId: 'ses_b',
  lastStartedSessionId: 'ses_b',
  ownerSessionId: 'ses_b',
  cachedSessionId: null,
  isLoading: false,
  hasMessages: false,
  terminalOpenFailure: false,
  localMessageCount: null,
  isReplayingLiveHistory: false,
  hasKnownSettings: false,
};

describe('resolveTranscriptPhase', () => {
  it('shows a chat created here as local until its live transcript loads', () => {
    const local = { ...base, localMessageCount: 0 };
    expect(resolveTranscriptPhase({ ...local, ownerSessionId: 'ses_a', hasMessages: true })).toBe(
      'local'
    );
    expect(resolveTranscriptPhase({ ...local, isLoading: true })).toBe('local');
    expect(resolveTranscriptPhase(local)).toBe('live');
    // A new session's first prompt stays until the live transcript has it.
    const withPrompt = { ...base, localMessageCount: 1, isReplayingLiveHistory: true };
    expect(resolveTranscriptPhase(withPrompt)).toBe('local');
    expect(resolveTranscriptPhase({ ...withPrompt, hasMessages: true })).toBe('live');
    expect(resolveTranscriptPhase({ ...withPrompt, isReplayingLiveHistory: false })).toBe('live');
  });

  it('shows the requested cached transcript before its metadata arrives', () => {
    expect(
      resolveTranscriptPhase({
        ...base,
        ownerSessionId: null,
        cachedSessionId: 'ses_b',
        hasMessages: true,
      })
    ).toBe('live');
  });

  it('shows a known chat without a loading state before its switch starts', () => {
    expect(
      resolveTranscriptPhase({ ...base, lastStartedSessionId: 'ses_a', hasKnownSettings: true })
    ).toBe('local');
  });

  it("does not show another session's cache, but shows this session's empty one", () => {
    expect(
      resolveTranscriptPhase({
        ...base,
        ownerSessionId: null,
        cachedSessionId: 'ses_a',
        hasMessages: true,
      })
    ).toBe('opening');
    expect(
      resolveTranscriptPhase({
        ...base,
        ownerSessionId: null,
        cachedSessionId: 'ses_b',
        hasMessages: false,
      })
    ).toBe('live');
  });

  it('keeps the switch pending until it starts even with a matching cached identity', () => {
    expect(
      resolveTranscriptPhase({
        ...base,
        lastStartedSessionId: 'ses_a',
        ownerSessionId: null,
        cachedSessionId: 'ses_b',
        hasMessages: true,
      })
    ).toBe('opening');
  });

  it('is live without a requested session even while stale state remains', () => {
    expect(
      resolveTranscriptPhase({
        ...base,
        requestedSessionId: null,
        lastStartedSessionId: 'ses_a',
        ownerSessionId: null,
        terminalOpenFailure: true,
      })
    ).toBe('live');
  });

  it('is opening when the requested session has not been started yet', () => {
    expect(
      resolveTranscriptPhase({
        ...base,
        lastStartedSessionId: null,
        ownerSessionId: null,
        terminalOpenFailure: true,
      })
    ).toBe('opening');
  });

  it('is opening on the click render for A to B', () => {
    expect(
      resolveTranscriptPhase({
        ...base,
        requestedSessionId: 'ses_b',
        lastStartedSessionId: 'ses_a',
        ownerSessionId: 'ses_a',
      })
    ).toBe('opening');
  });

  it('ignores a stale error from an older settled open on A to B to C', () => {
    expect(
      resolveTranscriptPhase({
        ...base,
        requestedSessionId: 'ses_c',
        lastStartedSessionId: 'ses_b',
        ownerSessionId: null,
        terminalOpenFailure: true,
      })
    ).toBe('opening');
  });

  it('is failed when the started open completed with an error and no owner', () => {
    expect(
      resolveTranscriptPhase({
        ...base,
        ownerSessionId: null,
        terminalOpenFailure: true,
      })
    ).toBe('failed');
  });

  it('is opening while the started open has an error but is still loading', () => {
    expect(
      resolveTranscriptPhase({
        ...base,
        ownerSessionId: null,
        isLoading: true,
        terminalOpenFailure: true,
      })
    ).toBe('opening');
  });

  it('keeps opening when metadata matches but the transcript is still loading', () => {
    expect(resolveTranscriptPhase({ ...base, isLoading: true })).toBe('opening');
  });

  it('is live while the owner matched and messages landed before replay finished', () => {
    expect(
      resolveTranscriptPhase({
        ...base,
        isLoading: true,
        hasMessages: true,
      })
    ).toBe('live');
  });

  it('is live when the owner matched and an error is set while still loading', () => {
    expect(
      resolveTranscriptPhase({
        ...base,
        isLoading: true,
        terminalOpenFailure: true,
      })
    ).toBe('live');
  });

  it('is live for a legitimately empty loaded session', () => {
    expect(resolveTranscriptPhase(base)).toBe('live');
  });

  it('is live for a legitimately empty loaded session even when an error is set', () => {
    expect(resolveTranscriptPhase({ ...base, terminalOpenFailure: true })).toBe('live');
  });

  it('is opening when the owner is an unrelated settled session', () => {
    expect(
      resolveTranscriptPhase({
        ...base,
        ownerSessionId: 'ses_stale',
      })
    ).toBe('opening');
  });

  it('does not read errorAtom', () => {
    const withErrorAtom = { ...base, ownerSessionId: null, errorAtom: 'stale transport error' };
    expect(resolveTranscriptPhase(withErrorAtom)).toBe(
      resolveTranscriptPhase({ ...base, ownerSessionId: null })
    );
  });
});

describe('transcriptReadyForEffects', () => {
  it('is true only for live', () => {
    expect(transcriptReadyForEffects('live')).toBe(true);
    expect(transcriptReadyForEffects('opening')).toBe(false);
    expect(transcriptReadyForEffects('failed')).toBe(false);
  });
});
