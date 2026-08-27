import { describe, expect, it, vi } from 'vitest';

import {
  applyVoiceDraftAtSelection,
  applyVoiceDraftToInput,
  resolveVoiceInsertion,
  resolveVoiceTranscriptDelta,
  type VoiceInputSelection,
} from './voice-input-draft';
import { appendVoiceTranscript } from './voice-input-state';

type NativeCall = { text: string };
type ChangeCall = string;

function makeInput() {
  const calls: NativeCall[] = [];
  const input = {
    setNativeProps(props: { text: string }): void {
      calls.push({ text: props.text });
    },
  };
  return { input, calls };
}

function makeChange() {
  const calls: ChangeCall[] = [];
  const onChangeText = (draft: string): void => {
    calls.push(draft);
  };
  return { onChangeText, calls };
}

describe('applyVoiceDraftToInput', () => {
  it('calls input.setNativeProps before onChangeText with the same draft', () => {
    const { input, calls: nativeCalls } = makeInput();
    const { onChangeText, calls: changeCalls } = makeChange();
    const order: string[] = [];
    const wrappedInput = {
      setNativeProps(props: { text: string }): void {
        order.push('native');
        input.setNativeProps(props);
      },
    };
    const wrappedChange = (draft: string): void => {
      order.push('change');
      onChangeText(draft);
    };

    applyVoiceDraftToInput({
      draft: 'hello world',
      input: wrappedInput,
      onChangeText: wrappedChange,
    });

    expect(order).toEqual(['native', 'change']);
    expect(nativeCalls).toEqual([{ text: 'hello world' }]);
    expect(changeCalls).toEqual(['hello world']);
  });

  it('still invokes the change path when the input ref is null', () => {
    const { onChangeText, calls } = makeChange();

    applyVoiceDraftToInput({ draft: 'hello', input: null, onChangeText });

    expect(calls).toEqual(['hello']);
  });

  it('does not throw and does not call setNativeProps when the input ref is null', () => {
    const { onChangeText } = makeChange();

    expect(() => {
      applyVoiceDraftToInput({ draft: 'hello', input: null, onChangeText });
    }).not.toThrow();
  });

  it('truncates both the native prop and the change callback to the same capped value when maxLength is provided', () => {
    const { input, calls: nativeCalls } = makeInput();
    const { onChangeText, calls: changeCalls } = makeChange();

    applyVoiceDraftToInput({ draft: 'abcdefghij', input, maxLength: 4, onChangeText });

    expect(nativeCalls).toEqual([{ text: 'abcd' }]);
    expect(changeCalls).toEqual(['abcd']);
  });

  it('does not truncate when maxLength is omitted, even for a long draft', () => {
    const { input, calls: nativeCalls } = makeInput();
    const { onChangeText, calls: changeCalls } = makeChange();
    const longDraft = 'a'.repeat(200);

    applyVoiceDraftToInput({ draft: longDraft, input, onChangeText });

    expect(nativeCalls).toEqual([{ text: longDraft }]);
    expect(changeCalls).toEqual([longDraft]);
  });

  it('does not truncate when maxLength is larger than the draft', () => {
    const { input, calls: nativeCalls } = makeInput();
    const { onChangeText, calls: changeCalls } = makeChange();

    applyVoiceDraftToInput({ draft: 'hi', input, maxLength: 50, onChangeText });

    expect(nativeCalls).toEqual([{ text: 'hi' }]);
    expect(changeCalls).toEqual(['hi']);
  });

  it('normalizes a negative maxLength to an empty value for both native prop and callback', () => {
    const { input, calls: nativeCalls } = makeInput();
    const { onChangeText, calls: changeCalls } = makeChange();

    applyVoiceDraftToInput({ draft: 'hello', input, maxLength: -3, onChangeText });

    expect(nativeCalls).toEqual([{ text: '' }]);
    expect(changeCalls).toEqual(['']);
  });

  it('invokes the change callback exactly once per call', () => {
    const onChangeText = vi.fn<(draft: string) => void>();
    const input = {
      setNativeProps: vi.fn(),
    };

    applyVoiceDraftToInput({ draft: 'hello', input, onChangeText });

    expect(onChangeText).toHaveBeenCalledTimes(1);
  });
});

type SelectionNativeCall = { text: string; selection?: VoiceInputSelection };

function makeSelectionInput() {
  const calls: SelectionNativeCall[] = [];
  const input = {
    setNativeProps(props: { text: string; selection?: VoiceInputSelection }): void {
      calls.push({ text: props.text, selection: props.selection });
    },
  };
  return { input, calls };
}

describe('resolveVoiceTranscriptDelta', () => {
  it('recovers the trimmed transcript appended by appendVoiceTranscript for every base', () => {
    const cases: { base: string; transcript: string }[] = [
      { base: '', transcript: 'hello' },
      { base: 'hello', transcript: 'world' },
      { base: 'hello ', transcript: 'world' },
      { base: 'hello\n', transcript: 'world' },
      { base: 'hello\t', transcript: 'world' },
      { base: 'hello', transcript: '  world again' },
      { base: 'hello', transcript: '' },
    ];

    for (const { base, transcript } of cases) {
      const merged = appendVoiceTranscript(base, transcript);
      expect(resolveVoiceTranscriptDelta(base, merged)).toBe(transcript.trimStart());
    }
  });

  it('returns an empty delta when the merged draft no longer starts with the base', () => {
    expect(resolveVoiceTranscriptDelta('hello', 'different world')).toBe('');
  });
});

describe('resolveVoiceInsertion', () => {
  it('inserts at the caret and lands the caret after the inserted text', () => {
    const result = resolveVoiceInsertion({
      baseDraft: 'hello world',
      baseSelection: { start: 5, end: 5 },
      transcript: 'there',
      maxLength: undefined,
    });

    expect(result.draft).toBe('hello there world');
    expect(result.selection).toEqual({ start: 11, end: 11 });
  });

  it('replaces the selected range', () => {
    const result = resolveVoiceInsertion({
      baseDraft: 'hello world',
      baseSelection: { start: 5, end: 11 },
      transcript: 'there',
      maxLength: undefined,
    });

    expect(result.draft).toBe('hello there');
    expect(result.selection).toEqual({ start: 11, end: 11 });
  });

  it('inserts at the draft end when no selection was reported', () => {
    const result = resolveVoiceInsertion({
      baseDraft: 'hello',
      baseSelection: null,
      transcript: 'world',
      maxLength: undefined,
    });

    expect(result.draft).toBe('hello world');
    expect(result.selection).toEqual({ start: 11, end: 11 });
  });

  it('truncates the transcript, not the surrounding text, at maxLength', () => {
    const result = resolveVoiceInsertion({
      baseDraft: 'hello world',
      baseSelection: { start: 5, end: 5 },
      transcript: 'there',
      maxLength: 14,
    });

    expect(result.draft).toBe('hello th world');
    expect(result.selection).toEqual({ start: 8, end: 8 });
  });
});

describe('applyVoiceDraftAtSelection', () => {
  it('inserts finalized speech at the caret instead of replacing the draft', () => {
    const { input, calls } = makeSelectionInput();
    const changeCalls: string[] = [];
    const mergedDraft = appendVoiceTranscript('hello world', 'there');

    const result = applyVoiceDraftAtSelection({
      baseDraft: 'hello world',
      baseSelection: { start: 5, end: 5 },
      currentDraft: 'hello world',
      expectedDraft: 'hello world',
      mergedDraft,
      isComposing: false,
      input,
      onChangeText: draft => {
        changeCalls.push(draft);
      },
    });

    expect(result).toEqual({
      kind: 'inserted',
      draft: 'hello there world',
      selection: { start: 11, end: 11 },
    });
    expect(calls).toEqual([{ text: 'hello there world', selection: { start: 11, end: 11 } }]);
    expect(changeCalls).toEqual(['hello there world']);
  });

  it('replaces the prior interim on the next result (live range stays anchored at the caret)', () => {
    const { input } = makeSelectionInput();
    const baseDraft = 'say hello';
    const firstMerged = appendVoiceTranscript(baseDraft, 'good');
    const secondMerged = appendVoiceTranscript(baseDraft, 'good morning');

    const first = applyVoiceDraftAtSelection({
      baseDraft,
      baseSelection: { start: 4, end: 4 },
      currentDraft: baseDraft,
      expectedDraft: baseDraft,
      mergedDraft: firstMerged,
      isComposing: false,
      input,
      onChangeText: () => undefined,
    });
    const second = applyVoiceDraftAtSelection({
      baseDraft,
      baseSelection: { start: 4, end: 4 },
      currentDraft: first.kind === 'inserted' ? first.draft : baseDraft,
      expectedDraft: first.kind === 'inserted' ? first.draft : baseDraft,
      mergedDraft: secondMerged,
      isComposing: false,
      input,
      onChangeText: () => undefined,
    });

    expect(second).toEqual({
      kind: 'inserted',
      draft: 'say good morning hello',
      selection: { start: 16, end: 16 },
    });
  });

  it('aborts and leaves the user text alone when the live draft diverged from the expected draft', () => {
    const { input, calls } = makeSelectionInput();
    const onChangeText = vi.fn<(draft: string) => void>();
    const mergedDraft = appendVoiceTranscript('hello world', 'there');

    const result = applyVoiceDraftAtSelection({
      baseDraft: 'hello world',
      baseSelection: { start: 5, end: 5 },
      currentDraft: 'hello edited world',
      expectedDraft: 'hello world',
      mergedDraft,
      isComposing: false,
      input,
      onChangeText,
    });

    expect(result).toEqual({ kind: 'aborted' });
    expect(calls).toEqual([]);
    expect(onChangeText).not.toHaveBeenCalled();
  });

  it('aborts and skips the insert when an IME composition is active', () => {
    const { input, calls } = makeSelectionInput();
    const onChangeText = vi.fn<(draft: string) => void>();
    const mergedDraft = appendVoiceTranscript('hello world', 'there');

    const result = applyVoiceDraftAtSelection({
      baseDraft: 'hello world',
      baseSelection: { start: 5, end: 5 },
      currentDraft: 'hello world',
      expectedDraft: 'hello world',
      mergedDraft,
      isComposing: true,
      input,
      onChangeText,
    });

    expect(result).toEqual({ kind: 'aborted' });
    expect(calls).toEqual([]);
    expect(onChangeText).not.toHaveBeenCalled();
  });

  it('still reports the inserted draft when the input ref is null', () => {
    const mergedDraft = appendVoiceTranscript('hello', 'world');

    const result = applyVoiceDraftAtSelection({
      baseDraft: 'hello',
      baseSelection: null,
      currentDraft: 'hello',
      expectedDraft: 'hello',
      mergedDraft,
      isComposing: false,
      input: null,
      onChangeText: () => undefined,
    });

    expect(result).toEqual({
      kind: 'inserted',
      draft: 'hello world',
      selection: { start: 11, end: 11 },
    });
  });
});
