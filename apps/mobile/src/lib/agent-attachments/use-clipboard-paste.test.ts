import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useClipboardPaste } from './use-clipboard-paste';

// ── Hoisted mocks ─────────────────────────────────────────────────────────

const hasClipboardImageMock = vi.hoisted(() => vi.fn<() => Promise<boolean>>());
const readClipboardImageFileMock = vi.hoisted(() =>
  vi.fn<() => Promise<{ uri: string; name: string; mimeType: string } | null>>()
);
const readClipboardTextMock = vi.hoisted(() => vi.fn<() => Promise<string>>());
const setHasImageMock = vi.hoisted(() => vi.fn<(value: boolean) => void>());

vi.mock('./clipboard-image', () => ({
  hasClipboardImage: hasClipboardImageMock,
  readClipboardImageFile: readClipboardImageFileMock,
  readClipboardText: readClipboardTextMock,
}));

vi.mock('react-native', () => ({
  AppState: {
    addEventListener: vi.fn(() => ({ remove: vi.fn() })),
  },
}));

// useCallback is identity: the hook returns the raw async functions.
// useRef objects are created once when the hook function runs, so every
// closure inside refresh/paste shares the same ref object.
// useState always returns the hoisted setter mock so tests can inspect
// what value setHasImage was called with.
vi.mock('react', () => ({
  useCallback: <T extends (...args: never[]) => unknown>(fn: T) => fn,
  useEffect: vi.fn(),
  useMemo: <T>(fn: () => T) => fn(),
  useRef: <T>(initial: T) => ({ current: initial }),
  useState: <T>(initial: T) => [initial, setHasImageMock] as [T, typeof setHasImageMock],
}));

// ── Helpers ───────────────────────────────────────────────────────────────

function makeOptions(overrides?: {
  enabled?: boolean;
  addFile?: () => Promise<void>;
  addText?: (text: string) => void;
  onUnreadable?: () => void;
}) {
  return {
    enabled: overrides?.enabled ?? true,
    addFile: overrides?.addFile ?? vi.fn().mockResolvedValue(undefined),
    addText: overrides?.addText,
    onUnreadable: overrides?.onUnreadable ?? vi.fn<() => void>(),
  };
}

/** Wait for the hook's async refresh/paste callbacks to settle. */
async function flushMicrotasks() {
  await Promise.resolve();
}

/** Extract the last boolean argument passed to setHasImage. */
function lastSetHasImageArg(): boolean | undefined {
  const calls = setHasImageMock.mock.calls;
  if (calls.length === 0) {
    return undefined;
  }
  return calls.at(-1)?.[0];
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('useClipboardPaste', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Happy: paste hides, later focus does not re-show ────────────────────

  it('refreshes and shows the hint when clipboard has an image', async () => {
    hasClipboardImageMock.mockResolvedValue(true);
    const hook = useClipboardPaste(makeOptions());

    hook.refresh();
    await flushMicrotasks();

    expect(lastSetHasImageArg()).toBe(true);
  });

  it('suppresses the hint on refresh after a successful paste', async () => {
    hasClipboardImageMock.mockResolvedValue(true);
    readClipboardImageFileMock.mockResolvedValue({
      uri: 'file:///cache/pasted.png',
      name: 'pasted-image.png',
      mimeType: 'image/png',
    });

    const hook = useClipboardPaste(makeOptions());

    // Initial refresh shows the image.
    hook.refresh();
    await flushMicrotasks();
    expect(lastSetHasImageArg()).toBe(true);

    // Paste succeeds: sets consumedRef = true and setHasImage(false).
    hook.paste();
    await flushMicrotasks();

    // SetHasImage is called with false by paste() (line ~107 in the hook).
    // The key test: a subsequent refresh must NOT re-show the hint.
    hook.refresh();
    await flushMicrotasks();

    // Clipboard still has image, but consumedRef blocks the show.
    expect(lastSetHasImageArg()).toBe(false);
  });

  it('hides the hint immediately on paste entry', async () => {
    hasClipboardImageMock.mockResolvedValue(true);
    readClipboardImageFileMock.mockResolvedValue({
      uri: 'file:///cache/pasted.png',
      name: 'pasted-image.png',
      mimeType: 'image/png',
    });

    const hook = useClipboardPaste(makeOptions());

    // Prime with an image.
    hook.refresh();
    await flushMicrotasks();
    expect(lastSetHasImageArg()).toBe(true);

    // Paste() calls setHasImage(false) synchronously before the async read.
    setHasImageMock.mockClear();
    hook.paste();

    // Paste's first action: setHasImage(false).
    expect(setHasImageMock).toHaveBeenCalledWith(false);

    await flushMicrotasks();
  });

  // ── Empty probe clears consumed state ───────────────────────────────────

  it('clears consumed state when a probe finds no image', async () => {
    hasClipboardImageMock.mockResolvedValue(true);
    readClipboardImageFileMock.mockResolvedValue({
      uri: 'file:///cache/pasted.png',
      name: 'pasted-image.png',
      mimeType: 'image/png',
    });

    const hook = useClipboardPaste(makeOptions());

    // Refresh shows image.
    hook.refresh();
    await flushMicrotasks();
    expect(lastSetHasImageArg()).toBe(true);

    // Paste succeeds — consumedRef set to true.
    hook.paste();
    await flushMicrotasks();

    // Probe with no image clears consumedRef.
    hasClipboardImageMock.mockResolvedValue(false);
    hook.refresh();
    await flushMicrotasks();
    expect(lastSetHasImageArg()).toBe(false);

    // A new image appears.
    hasClipboardImageMock.mockResolvedValue(true);
    hook.refresh();
    await flushMicrotasks();

    // consumedRef was cleared, so the new image shows.
    expect(lastSetHasImageArg()).toBe(true);
  });

  // ── Retryable unhappy: failed read does not consume ─────────────────────

  it('does not consume the image on a failed clipboard read', async () => {
    hasClipboardImageMock.mockResolvedValue(true);
    readClipboardImageFileMock.mockResolvedValue(null);

    const onUnreadable = vi.fn<() => void>();
    const hook = useClipboardPaste(makeOptions({ onUnreadable }));

    // Refresh shows the image.
    hook.refresh();
    await flushMicrotasks();
    expect(lastSetHasImageArg()).toBe(true);

    // Paste fails — readClipboardImageFile returns null.
    hook.paste();
    await flushMicrotasks();

    expect(onUnreadable).toHaveBeenCalledOnce();

    // Subsequent refresh can still show the image (not consumed).
    hook.refresh();
    await flushMicrotasks();
    expect(lastSetHasImageArg()).toBe(true);
  });

  // ── Text fallback: paste is always available, so text must paste ────────

  it('pastes clipboard text without reading an image the clipboard does not hold', async () => {
    hasClipboardImageMock.mockResolvedValue(false);
    readClipboardImageFileMock.mockResolvedValue(null);
    readClipboardTextMock.mockResolvedValue('https://example.com/spec');

    const addText = vi.fn<(text: string) => void>();
    const onUnreadable = vi.fn<() => void>();
    const hook = useClipboardPaste(makeOptions({ addText, onUnreadable }));

    hook.paste();
    await flushMicrotasks();
    await flushMicrotasks();

    expect(addText).toHaveBeenCalledWith('https://example.com/spec');
    expect(onUnreadable).not.toHaveBeenCalled();
    // The image read raises the iOS 16 paste prompt; a text clipboard must
    // never reach it.
    expect(readClipboardImageFileMock).not.toHaveBeenCalled();
  });

  it('pastes the text when the clipboard holds an image it cannot read', async () => {
    hasClipboardImageMock.mockResolvedValue(true);
    readClipboardImageFileMock.mockResolvedValue(null);
    readClipboardTextMock.mockResolvedValue('fallback text');

    const addText = vi.fn<(text: string) => void>();
    const onUnreadable = vi.fn<() => void>();
    const hook = useClipboardPaste(makeOptions({ addText, onUnreadable }));

    hook.paste();
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();

    expect(readClipboardImageFileMock).toHaveBeenCalledOnce();
    expect(addText).toHaveBeenCalledWith('fallback text');
    expect(onUnreadable).not.toHaveBeenCalled();
  });

  it('toasts unreadable when neither an image nor text is on the clipboard', async () => {
    hasClipboardImageMock.mockResolvedValue(false);
    readClipboardImageFileMock.mockResolvedValue(null);
    readClipboardTextMock.mockResolvedValue('');

    const addText = vi.fn<(text: string) => void>();
    const onUnreadable = vi.fn<() => void>();
    const hook = useClipboardPaste(makeOptions({ addText, onUnreadable }));

    hook.paste();
    await flushMicrotasks();
    await flushMicrotasks();

    expect(addText).not.toHaveBeenCalled();
    expect(onUnreadable).toHaveBeenCalledOnce();
  });

  it('keeps the image-only behavior when the caller omits addText', async () => {
    hasClipboardImageMock.mockResolvedValue(true);
    readClipboardImageFileMock.mockResolvedValue(null);
    readClipboardTextMock.mockResolvedValue('some text');

    const onUnreadable = vi.fn<() => void>();
    const hook = useClipboardPaste(makeOptions({ onUnreadable }));

    hook.paste();
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();

    expect(readClipboardTextMock).not.toHaveBeenCalled();
    expect(onUnreadable).toHaveBeenCalledOnce();
  });

  // ── Non-retryable unhappy: addFile rejection still consumes ─────────────

  it('keeps the hint hidden after addFile rejects', async () => {
    hasClipboardImageMock.mockResolvedValue(true);
    readClipboardImageFileMock.mockResolvedValue({
      uri: 'file:///cache/pasted.png',
      name: 'pasted-image.png',
      mimeType: 'image/png',
    });
    const addFile = vi.fn().mockRejectedValue(new Error('upload failed'));

    const hook = useClipboardPaste(makeOptions({ addFile }));

    // Refresh shows image.
    hook.refresh();
    await flushMicrotasks();
    expect(lastSetHasImageArg()).toBe(true);

    // Paste reads the image successfully but addFile rejects.
    hook.paste();
    await flushMicrotasks();

    expect(addFile).toHaveBeenCalledOnce();

    // Clipboard still has the image, but it was consumed.
    hook.refresh();
    await flushMicrotasks();
    expect(lastSetHasImageArg()).toBe(false);
  });

  // ── Guard: double-tap protection ────────────────────────────────────────

  it('guards against a double tap via inFlightRef', async () => {
    hasClipboardImageMock.mockResolvedValue(true);
    // Never resolves — the first paste is in flight indefinitely.
    let resolvePaste: (value: { uri: string; name: string; mimeType: string }) => void =
      undefined as never;
    const pastePromise = new Promise<{ uri: string; name: string; mimeType: string }>(resolve => {
      resolvePaste = resolve;
    });
    readClipboardImageFileMock.mockReturnValue(pastePromise);

    const hook = useClipboardPaste(makeOptions());

    // Refresh shows image.
    hook.refresh();
    await flushMicrotasks();
    expect(lastSetHasImageArg()).toBe(true);

    // First paste: inFlightRef = true.
    hook.paste();
    await flushMicrotasks();

    // Second paste: blocked by inFlightRef.
    setHasImageMock.mockClear();
    hook.paste();

    // setHasImage should NOT be called again (paste was blocked).
    expect(setHasImageMock).not.toHaveBeenCalled();

    // Resolve the first paste.
    resolvePaste({ uri: 'file:///cache/pasted.png', name: 'pasted.png', mimeType: 'image/png' });
    await flushMicrotasks();
  });

  // ── Guard: stale refresh epoch protection ───────────────────────────────

  it('discards a stale refresh that resolves after paste hid the hint', async () => {
    // First refresh probe will be slow; paste will run and hide the hint
    // before the first refresh resolves.
    let resolveFirstRefresh: (value: boolean) => void = undefined as never;
    const firstRefreshPromise = new Promise<boolean>(resolve => {
      resolveFirstRefresh = resolve;
    });
    hasClipboardImageMock.mockReturnValueOnce(firstRefreshPromise);

    const hook = useClipboardPaste(makeOptions());

    // Start a refresh (slow — won't resolve yet).
    hook.refresh();

    // Paste succeeds immediately (fast path).
    readClipboardImageFileMock.mockResolvedValue({
      uri: 'file:///cache/pasted.png',
      name: 'pasted-image.png',
      mimeType: 'image/png',
    });
    setHasImageMock.mockClear();
    hook.paste();
    await flushMicrotasks();
    // Paste called setHasImage(false).
    expect(setHasImageMock).toHaveBeenCalledWith(false);

    // Now the stale refresh resolves. It sees the epoch has advanced
    // (paste incremented it), so it discards its result.
    setHasImageMock.mockClear();
    resolveFirstRefresh(true);
    await flushMicrotasks();

    // The stale refresh must NOT call setHasImage.
    expect(setHasImageMock).not.toHaveBeenCalled();
  });

  // ── Mid-paste refresh race ───────────────────────────────────────────────

  it('prevents a refresh that starts after paste entry from re-showing the hint', async () => {
    hasClipboardImageMock.mockResolvedValue(true);
    // Never resolves — paste stays in flight indefinitely.
    let resolveRead: (value: { uri: string; name: string; mimeType: string }) => void =
      undefined as never;
    const readPromise = new Promise<{ uri: string; name: string; mimeType: string }>(resolve => {
      resolveRead = resolve;
    });
    readClipboardImageFileMock.mockReturnValue(readPromise);

    const hook = useClipboardPaste(makeOptions());

    // Refresh shows the image.
    hook.refresh();
    await flushMicrotasks();
    expect(lastSetHasImageArg()).toBe(true);

    // Paste starts: calls setHasImage(false), sets suppressVisibilityRef,
    // then awaits readClipboardImageFile (in flight).
    setHasImageMock.mockClear();
    hook.paste();
    await flushMicrotasks();
    expect(setHasImageMock).toHaveBeenCalledWith(false);

    // Mid-paste refresh: clipboard still has an image, paste is in flight.
    setHasImageMock.mockClear();
    hasClipboardImageMock.mockResolvedValue(true);
    hook.refresh();
    await flushMicrotasks();

    // The mid-paste refresh must NOT show the hint.
    // It may call setHasImage(false) but never true.
    const trueCalls = setHasImageMock.mock.calls.filter((call: unknown[]) => call[0] === true);
    expect(trueCalls).toHaveLength(0);

    // Resolve paste to clean up.
    resolveRead({ uri: 'file:///cache/pasted.png', name: 'pasted.png', mimeType: 'image/png' });
    await flushMicrotasks();
  });
});
