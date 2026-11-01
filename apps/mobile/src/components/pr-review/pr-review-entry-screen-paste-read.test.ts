// The paste control runs a fire-and-forget press handler, so a clipboard read
// the platform refuses must still end in a visible result. These cases live
// apart from the URL-field suite to keep both files within the lint line cap.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { find, flush, mocks, propsOf, renderLoaded, resetHookSlots } from './pr-review-entry-screen-test-utils';

beforeEach(() => {
  vi.clearAllMocks();
  resetHookSlots();
  mocks.clipboard.current = '';
  mocks.clipboardHasString.current = false;
  mocks.clipboardFailure.current = null;
  mocks.clipboardHasStringFailure.current = null;
});

function pasteControl(tree: unknown) {
  return find(
    tree,
    'Pressable',
    p => p.accessibilityLabel === 'Paste pull request or merge request link'
  );
}

describe('paste clipboard read failures', () => {
  it('reports a refused read instead of leaving the tap without a result', async () => {
    mocks.clipboardFailure.current = new Error('clipboard unavailable');
    const tree = await renderLoaded();
    await (propsOf(pasteControl(tree)).onPress as () => Promise<void>)();
    await flush();
    expect(mocks.toastError).toHaveBeenCalledWith(
      'Paste access was denied. Allow paste and try again.'
    );
    expect(mocks.toastError).toHaveBeenCalledTimes(1);
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it('reports the same denial when only the text probe fails', async () => {
    mocks.clipboardHasStringFailure.current = new Error('clipboard unavailable');
    const tree = await renderLoaded();
    await (propsOf(pasteControl(tree)).onPress as () => Promise<void>)();
    await flush();
    expect(mocks.toastError).toHaveBeenCalledWith(
      'Paste access was denied. Allow paste and try again.'
    );
    expect(mocks.toastError).not.toHaveBeenCalledWith('Clipboard is empty');
    expect(mocks.push).not.toHaveBeenCalled();
  });
});