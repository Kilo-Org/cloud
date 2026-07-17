import { describe, expect, it, vi } from 'vitest';

import { applyVoiceDraftToInput } from './voice-input-draft';

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
