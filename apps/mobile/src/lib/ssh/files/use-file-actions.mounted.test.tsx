import { afterEach, expect, it, vi } from 'vitest';
import { act, type ReactTestRenderer, TestRenderer } from '@/test/renderer';
import { useFileActions } from './use-file-actions';
import { type FilePreview } from '@/components/ssh/files/file-preview-sheet';

const native = vi.hoisted(() => ({
  download: vi.fn<(channel: string, remote: string, local: string) => Promise<void>>(),
}));
vi.mock('../native', () => ({
  sshPackage: () => Promise.resolve(native),
  nativeErrorCode: () => 'Protocol',
}));
vi.mock('expo-file-system', () => ({
  File: class {
    exists = false;
    content = 'content';
    text = () => Promise.resolve(this.content);
  },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('sonner-native', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/lib/share-remote-file', () => ({ shareLocalFile: vi.fn() }));
vi.mock('./uploads', () => ({ pickDocuments: vi.fn(), pickPhotos: vi.fn() }));
vi.mock('./transfers', () => ({
  subscribeTransfers: () => vi.fn<() => void>(),
  transfersSnapshot: () => snapshot,
  transfersForSession: () => snapshot,
  transferLocalUri: (id: string) => `file://${id}`,
  downloadedFileUri: vi.fn(),
  startDownload: vi.fn(),
  startUpload: vi.fn(),
}));
const snapshot: never[] = [];
let actions: {
  preview: FilePreview | null;
  openPreview: (entry: typeof image) => Promise<void>;
  closePreview: () => void;
} = { preview: null, openPreview: () => Promise.resolve(), closePreview: vi.fn<() => void>() };
let mounted: ReactTestRenderer | undefined = undefined;
function Probe() {
  actions = useFileActions({
    sessionId: 'session',
    sftpId: 'channel',
    path: '/',
    entries: [],
    onNavigate: vi.fn<() => void>(),
    onChanged: vi.fn<() => void>(),
    confirm: vi.fn<() => void>(),
  });
  return null;
}
const image = {
  name: 'image.png',
  kind: 'file' as const,
  size: 1,
  modifiedUnix: null,
  permissions: null,
};
afterEach(() => {
  act(() => mounted?.unmount());
  vi.clearAllMocks();
});
it.each(['resolve', 'reject'] as const)(
  'ignores a download that %ss after dismissal',
  async outcome => {
    const download = Promise.withResolvers<undefined>();
    native.download.mockReturnValueOnce(download.promise);
    await act(async () => {
      mounted = TestRenderer.create(<Probe />);
      await Promise.resolve();
    });
    let pending = Promise.resolve();
    await act(async () => {
      pending = actions.openPreview(image);
      await Promise.resolve();
    });
    act(() => {
      actions.closePreview();
    });
    await act(async () => {
      if (outcome === 'resolve') {
        download.resolve(undefined);
      } else {
        download.reject(new Error('late'));
      }
      await pending;
    });
    expect(actions.preview).toBeNull();
  }
);
it('keeps the newer preview when the old download completes last', async () => {
  const download = Promise.withResolvers<undefined>();
  native.download.mockReturnValueOnce(download.promise).mockResolvedValue(undefined);
  await act(async () => {
    mounted = TestRenderer.create(<Probe />);
    await Promise.resolve();
  });
  let pending = Promise.resolve();
  await act(async () => {
    pending = actions.openPreview(image);
    await Promise.resolve();
  });
  await act(async () => {
    await actions.openPreview({ ...image, name: 'new.png' });
  });
  await act(async () => {
    download.resolve(undefined);
    await pending;
  });
  expect(actions.preview?.name).toBe('new.png');
});
