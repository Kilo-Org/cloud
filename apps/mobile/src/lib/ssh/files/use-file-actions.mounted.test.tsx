import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, type ReactTestRenderer, TestRenderer } from '@/test/renderer';
import { fakeFs } from './fake-file-system.test-helpers';
import { useFileActions } from './use-file-actions';
import { type FilePreview } from '@/components/ssh/files/file-preview-sheet';

const native = vi.hoisted(() => ({
  download: vi.fn<(channel: string, remote: string, local: string) => Promise<void>>(),
}));
vi.mock('../native', () => ({
  sshPackage: () => Promise.resolve(native),
  nativeErrorCode: () => 'Protocol',
}));

vi.mock('expo-file-system', async () => {
  const { fakeFs: fake } = await import('./fake-file-system.test-helpers');
  return { Directory: fake.Directory, File: fake.File, Paths: fake.Paths };
});
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('sonner-native', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/lib/share-remote-file', () => ({
  shareLocalFile: vi.fn(),
  getSafeCacheFilename: ({ id, filename }: { id: string; filename: string }) => `${id}-${filename}`,
}));
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

const previewDirectory = 'file:///cache/ssh-file-previews';
const downloadDirectory = 'file:///cache/ssh-files';

function previewFiles(): string[] {
  return [...fakeFs.files.keys()].filter(uri => uri.startsWith(`${previewDirectory}/`));
}

let actions: {
  preview: FilePreview | null;
  openPreview: (entry: typeof image) => Promise<void>;
  closePreview: () => void;
  showPreview: (preview: FilePreview) => void;
} = {
  preview: null,
  openPreview: () => Promise.resolve(),
  closePreview: vi.fn<() => void>(),
  showPreview: vi.fn<(preview: FilePreview) => void>(),
};
let mounted: ReactTestRenderer[] = [];
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

async function openPreviewCopy(name: string = image.name): Promise<string> {
  await act(async () => {
    await actions.openPreview({ ...image, name });
  });
  const uri = actions.preview?.uri;
  if (uri === null || uri === undefined) {
    throw new Error('expected a downloaded preview');
  }
  return uri;
}

async function mountProbe(): Promise<void> {
  await act(async () => {
    mounted.push(TestRenderer.create(<Probe />));
    await Promise.resolve();
  });
}

function unmountAll(): void {
  act(() => {
    for (const renderer of mounted) {
      renderer.unmount();
    }
  });
  mounted = [];
}

beforeEach(() => {
  fakeFs.reset();
  native.download.mockReset();
  native.download.mockImplementation((_channel, _remote, local) => {
    fakeFs.files.set(local, 'bytes');
    return Promise.resolve();
  });
});

afterEach(() => {
  unmountAll();
  vi.clearAllMocks();
});

it.each(['resolve', 'reject'] as const)(
  'ignores a download that %ss after dismissal',
  async outcome => {
    const download = Promise.withResolvers<undefined>();
    native.download.mockImplementationOnce(async (_channel, _remote, local) => {
      try {
        await download.promise;
      } catch (error) {
        fakeFs.files.set(local, 'partial');
        throw error;
      }
      fakeFs.files.set(local, 'bytes');
    });
    await mountProbe();
    let pending = Promise.resolve();
    await act(async () => {
      pending = actions.openPreview(image);
      await Promise.resolve();
    });
    const local = native.download.mock.calls[0]?.[2];
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
    if (local === undefined) {
      throw new Error('expected the preview download');
    }
    expect(fakeFs.files.has(local)).toBe(false);
  }
);

it('keeps the newer preview when the old download completes last', async () => {
  const download = Promise.withResolvers<undefined>();
  native.download.mockImplementationOnce(async (_channel, _remote, local) => {
    await download.promise;
    fakeFs.files.set(local, 'old bytes');
  });
  await mountProbe();
  let pending = Promise.resolve();
  await act(async () => {
    pending = actions.openPreview(image);
    await Promise.resolve();
  });
  const superseded = native.download.mock.calls[0]?.[2];
  await act(async () => {
    await actions.openPreview({ ...image, name: 'new.png' });
  });
  await act(async () => {
    download.resolve(undefined);
    await pending;
  });
  expect(actions.preview?.name).toBe('new.png');
  expect(previewFiles()).toEqual([actions.preview?.uri]);
  if (superseded === undefined) {
    throw new Error('expected the superseded download');
  }
  expect(fakeFs.files.has(superseded)).toBe(false);
});

it('deletes the preview copy when the preview closes', async () => {
  await mountProbe();
  const uri = await openPreviewCopy();
  expect(fakeFs.files.has(uri)).toBe(true);

  act(() => {
    actions.closePreview();
  });

  expect(fakeFs.files.has(uri)).toBe(false);
});

it('deletes the preview copy when the screen unmounts', async () => {
  await mountProbe();
  const uri = await openPreviewCopy();

  unmountAll();

  expect(fakeFs.files.has(uri)).toBe(false);
});

it('deletes the preview copy when a fixture preview replaces it', async () => {
  await mountProbe();
  const uri = await openPreviewCopy();

  act(() => {
    actions.showPreview({
      name: 'fixture.log',
      kind: 'text',
      loading: false,
      code: null,
      uri: null,
      text: 'fixture',
    });
  });

  expect(fakeFs.files.has(uri)).toBe(false);
});

it('drops the copy a failed download left behind', async () => {
  native.download.mockImplementationOnce((_channel, _remote, local) => {
    fakeFs.files.set(local, 'partial');
    return Promise.reject(new Error('boom'));
  });
  await mountProbe();

  await act(async () => {
    await actions.openPreview(image);
  });

  expect(actions.preview?.code).toBe('Protocol');
  expect(previewFiles()).toEqual([]);
});

it('clears previews left by an earlier mount and leaves downloads alone', async () => {
  fakeFs.directories.add(previewDirectory);
  const stale = `${previewDirectory}/preview-old-image.png`;
  const download = `${downloadDirectory}/transfer-1-report.pdf`;
  fakeFs.files.set(stale, 'bytes');
  fakeFs.files.set(download, 'bytes');

  await mountProbe();

  expect(fakeFs.files.has(stale)).toBe(false);
  expect(fakeFs.files.get(download)).toBe('bytes');
});

it('keeps a download copy when a preview comes and goes', async () => {
  const download = `${downloadDirectory}/transfer-1-report.pdf`;
  fakeFs.files.set(download, 'bytes');
  await mountProbe();
  await openPreviewCopy();

  act(() => {
    actions.closePreview();
  });
  unmountAll();

  expect(fakeFs.files.get(download)).toBe('bytes');
});

it('keeps a preview another mounted screen still shows', async () => {
  await mountProbe();
  const uri = await openPreviewCopy();

  await mountProbe();

  expect(fakeFs.files.has(uri)).toBe(true);
});
