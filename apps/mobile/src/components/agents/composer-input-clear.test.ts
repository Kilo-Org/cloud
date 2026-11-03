import { describe, expect, it } from 'vitest';

import { clearComposerInput } from './composer-input-clear';

// The native TextInput accepts a write only from whichever path last wrote its
// text: after a keystroke, `clear()` empties it and a `setNativeProps` text
// write is dropped; after a programmatic write (share prefill, Retry restore,
// stop remount), `setNativeProps` empties it and `clear()` is dropped. Both
// refusals were measured on Android: a bare `clear()` left an auto-sent first
// prompt visible in the session composer. The helper must empty the field in
// either state.

type LastWriter = 'keystroke' | 'programmatic';

type FakeInput = {
  text: string;
  clear: () => void;
  setNativeProps: (props: { text: string; selection: { start: number; end: number } }) => void;
};

function makeInput(lastWriter: LastWriter, initialText: string): FakeInput {
  const input: FakeInput = {
    text: initialText,
    clear: () => {
      if (lastWriter === 'keystroke') {
        input.text = '';
      }
    },
    setNativeProps: props => {
      if (lastWriter === 'programmatic') {
        input.text = props.text;
      }
    },
  };
  return input;
}

describe('clearComposerInput', () => {
  it('empties a field whose last programmatic write refuses clear()', () => {
    const input = makeInput('programmatic', 'Hallo, bitte pruefe die README.');

    clearComposerInput(input);

    expect(input.text).toBe('');
  });

  it('empties a field whose last keystroke refuses setNativeProps()', () => {
    const input = makeInput('keystroke', 'typed by hand');

    clearComposerInput(input);

    expect(input.text).toBe('');
  });

  it('asks for the empty text with the caret at the start', () => {
    const input = makeInput('programmatic', 'prefilled');
    const calls: { text: string; selection: { start: number; end: number } }[] = [];
    input.setNativeProps = props => {
      calls.push(props);
    };

    clearComposerInput(input);

    expect(calls).toEqual([{ text: '', selection: { start: 0, end: 0 } }]);
  });

  it('is a no-op without an input', () => {
    expect(() => {
      clearComposerInput(null);
    }).not.toThrow();
  });
});
