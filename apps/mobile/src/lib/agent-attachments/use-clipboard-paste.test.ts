import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useClipboardPaste } from './use-clipboard-paste';
import { type ClipboardImageFile } from './clipboard-image';

const mocks = vi.hoisted(() => ({
  hasImage: vi.fn<() => Promise<boolean>>(),
  hasUrl: vi.fn<() => Promise<boolean>>(),
  readImage: vi.fn<(maxBytes?: number) => Promise<ClipboardImageFile | 'too-large' | null>>(),
  readText: vi.fn<() => Promise<string>>(),
}));
vi.mock('react', () => ({
  useCallback: <T>(fn: T) => fn,
  useEffect: (effect: () => void) => {
    effect();
  },
  useRef: <T>(current: T) => ({ current }),
}));
vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));
vi.mock('./clipboard-image', () => ({
  hasClipboardImage: mocks.hasImage,
  hasClipboardUrl: mocks.hasUrl,
  readClipboardImageFile: mocks.readImage,
  readClipboardText: mocks.readText,
}));

const image = { uri: 'file:///clipboard.png', name: 'clipboard.png', mimeType: 'image/png' };

function options() {
  return {
    addFile: vi.fn<(file: ClipboardImageFile) => Promise<void>>().mockResolvedValue(undefined),
    addText: vi.fn<(text: string) => void>(),
    onFailure: vi.fn<(reason: 'empty' | 'unreadable' | 'too-large') => void>(),
    maxBytes: 20_000_000,
  };
}

describe('composer clipboard paste', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.hasImage.mockResolvedValue(false);
    mocks.hasUrl.mockResolvedValue(false);
    mocks.readText.mockResolvedValue('');
  });

  it('attaches images first and prevents duplicate paste submissions', async () => {
    const callbacks = options();
    mocks.hasImage.mockResolvedValue(true);
    mocks.readImage.mockResolvedValue(image);
    const { paste } = useClipboardPaste(callbacks);
    paste();
    paste();
    await vi.waitFor(() => {
      expect(callbacks.addFile).toHaveBeenCalledOnce();
    });
    expect(callbacks.addFile).toHaveBeenCalledWith(image);
    expect(mocks.readImage).toHaveBeenCalledWith(callbacks.maxBytes);
    expect(mocks.readText).not.toHaveBeenCalled();
  });

  it('pastes text without reading or writing an image', async () => {
    const callbacks = options();
    mocks.readText.mockResolvedValue('draft text');
    useClipboardPaste(callbacks).paste();
    await vi.waitFor(() => {
      expect(callbacks.addText).toHaveBeenCalledWith('draft text');
    });
    expect(mocks.readImage).not.toHaveBeenCalled();
    expect(callbacks.onFailure).not.toHaveBeenCalled();
  });

  it.each(['empty', 'unreadable', 'too-large'] as const)(
    'reports %s clipboard content',
    async reason => {
      const callbacks = options();
      mocks.hasImage.mockResolvedValue(reason !== 'empty');
      mocks.readImage.mockResolvedValue(reason === 'too-large' ? 'too-large' : null);
      useClipboardPaste(callbacks).paste();
      await vi.waitFor(() => {
        expect(callbacks.onFailure).toHaveBeenCalledWith(reason);
      });
      expect(callbacks.addFile).not.toHaveBeenCalled();
    }
  );

  it('reports a denied URL read as unreadable instead of empty', async () => {
    const callbacks = options();
    mocks.hasUrl.mockResolvedValue(true);
    useClipboardPaste(callbacks).paste();
    await vi.waitFor(() => {
      expect(callbacks.onFailure).toHaveBeenCalledWith('unreadable');
    });
  });
});
