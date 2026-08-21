import { type ActionSheetProps } from '@expo/react-native-action-sheet';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import * as SecureStore from 'expo-secure-store';
import * as Sentry from '@sentry/react-native';
import { describe, expect, it, vi } from 'vitest';

import { normalizeImageAsset, pickAgentAttachments } from './attachment-picker';

const reactNativeMock = vi.hoisted(() => ({
  alert: vi.fn(),
  openSettings: vi.fn(),
}));

const announcingToastMock = vi.hoisted(() => ({ error: vi.fn() }));

vi.mock('react-native', () => ({
  Alert: { alert: reactNativeMock.alert },
  Linking: { openSettings: reactNativeMock.openSettings },
}));

vi.mock('@/lib/a11y/announcing-toast', () => ({
  announcingToast: { error: announcingToastMock.error, success: vi.fn(), warning: vi.fn() },
}));

vi.mock('expo-document-picker', () => ({
  getDocumentAsync: vi.fn(),
}));

vi.mock('expo-image-picker', () => ({
  launchCameraAsync: vi.fn(),
  launchImageLibraryAsync: vi.fn(),
  requestCameraPermissionsAsync: vi.fn(),
}));

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));

vi.mock('@sentry/react-native', () => ({
  captureException: vi.fn(),
}));

const getDocumentAsyncMock = vi.mocked(DocumentPicker.getDocumentAsync);

type ShowActionSheet = ActionSheetProps['showActionSheetWithOptions'];
type SheetButtonHandler = Parameters<ShowActionSheet>[1];

/**
 * Drive `pickAgentAttachments` by capturing the sheet handler the
 * production code registers, then invoking it with a button index.
 * Avoids inline callback-shaped mocks that trip prefer-await-to-callbacks.
 */
async function pickWithSheetSelection(
  buttonIndex: number
): Promise<Awaited<ReturnType<typeof pickAgentAttachments>>> {
  const showActionSheet = vi.fn() as unknown as ShowActionSheet & {
    mock: { calls: [unknown, SheetButtonHandler][] };
  };
  const resultPromise = pickAgentAttachments(showActionSheet, {
    userId: 'user-1',
    surface: 'agent-chat',
    sessionId: 'sess-1',
  });
  const registered = showActionSheet.mock.calls[0]?.[1];
  expect(registered).toEqual(expect.any(Function));
  await Promise.resolve(registered?.(buttonIndex));
  return resultPromise;
}

describe('normalizeImageAsset', () => {
  it('keeps the picker fileName when present', () => {
    expect(
      normalizeImageAsset({
        uri: 'file:///tmp/IMG_0001.HEIC',
        fileName: 'IMG_0001.HEIC',
        mimeType: 'application/octet-stream',
      }).name
    ).toBe('IMG_0001.HEIC');
  });

  it('treats a whitespace-only fileName as missing and synthesizes from the URI', () => {
    expect(
      normalizeImageAsset({
        uri: 'file:///tmp/IMG_0001.HEIC',
        fileName: '   ',
        mimeType: 'application/octet-stream',
      }).name
    ).toBe('image.heic');
  });

  it('synthesizes image.heic from the URI extension when fileName is missing', () => {
    expect(
      normalizeImageAsset({
        uri: 'file:///tmp/IMG_0001.HEIC',
        mimeType: 'application/octet-stream',
      }).name
    ).toBe('image.heic');
  });

  it('synthesizes image.jpeg from the MIME subtype for an extension-less URI', () => {
    expect(
      normalizeImageAsset({
        uri: 'file:///tmp/Camera/uuid',
        mimeType: 'image/jpeg',
      }).name
    ).toBe('image.jpeg');
  });

  it('falls back to image.png when no signal carries the extension', () => {
    expect(
      normalizeImageAsset({
        uri: 'file:///tmp/Camera/uuid',
      }).name
    ).toBe('image.png');
  });
});

describe('agent attachment picker', () => {
  it('opens a native action sheet that keeps all sources and the cancel action', () => {
    const showActionSheet = vi.fn() as unknown as ShowActionSheet & {
      mock: { calls: unknown[][] };
    };

    void pickAgentAttachments(showActionSheet, {
      userId: 'user-1',
      surface: 'agent-chat',
      sessionId: null,
    });

    expect(showActionSheet).toHaveBeenCalledWith(
      {
        options: ['Camera', 'Photo Library', 'Files', 'Cancel'],
        cancelButtonIndex: 3,
      },
      expect.any(Function)
    );
    expect(reactNativeMock.alert).not.toHaveBeenCalled();
  });

  // Android unregisters the picker's ActivityResultLauncher when the launching
  // Activity is destroyed, so every later launch rejects until the process
  // restarts. Surface it instead of rejecting into an unhandled promise.
  it('toasts a recovery hint when the library launch rejects', async () => {
    announcingToastMock.error.mockClear();
    vi.mocked(ImagePicker.launchImageLibraryAsync).mockRejectedValueOnce(
      new Error("Call to function 'ExponentImagePicker.launchImageLibraryAsync' has been rejected.")
    );

    expect(await pickWithSheetSelection(1)).toEqual([]);
    expect(announcingToastMock.error).toHaveBeenCalledWith(
      'Could not open the photo picker. Restart Kilo and try again.'
    );
  });

  it('launches the picker when the launch context write fails', async () => {
    vi.mocked(SecureStore.setItemAsync).mockRejectedValueOnce(new Error('store write failed'));
    const result: Awaited<ReturnType<typeof ImagePicker.launchImageLibraryAsync>> = {
      canceled: false,
      assets: [{ uri: 'file:///cache/photo.jpg', width: 100, height: 100 }],
    };
    vi.mocked(ImagePicker.launchImageLibraryAsync).mockResolvedValueOnce(result);

    const candidates = await pickWithSheetSelection(1);

    expect(candidates).toHaveLength(1);
    expect(Sentry.captureException).toHaveBeenCalled();
  });
});

describe('agent attachment picker (document MIME derivation)', () => {
  it('derives MIME from the extension, never from the picker MIME', async () => {
    getDocumentAsyncMock.mockResolvedValueOnce({
      canceled: false,
      assets: [
        {
          uri: 'file:///cache/notes.md',
          name: 'notes.md',
          mimeType: 'application/octet-stream',
          size: 12,
        },
      ],
    } as unknown as Awaited<ReturnType<typeof DocumentPicker.getDocumentAsync>>);

    const candidates = await pickWithSheetSelection(2);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.name).toBe('notes.md');
    // The picker reported `application/octet-stream`; the picker must
    // ignore it and return the extension-derived MIME.
    expect(candidates[0]?.mimeType).toBe('text/plain');
  });

  it('returns application/octet-stream for an extension outside the canonical table', async () => {
    getDocumentAsyncMock.mockResolvedValueOnce({
      canceled: false,
      assets: [
        {
          uri: 'file:///cache/clip.mov',
          name: 'clip.mov',
          mimeType: 'video/quicktime',
          size: 12,
        },
      ],
    } as unknown as Awaited<ReturnType<typeof DocumentPicker.getDocumentAsync>>);

    const candidates = await pickWithSheetSelection(2);
    expect(candidates[0]?.mimeType).toBe('application/octet-stream');
  });

  it('falls back to application/octet-stream for a filename with no usable extension', async () => {
    getDocumentAsyncMock.mockResolvedValueOnce({
      canceled: false,
      assets: [
        {
          uri: 'file:///cache/README',
          name: 'README',
          mimeType: 'text/plain',
          size: 12,
        },
      ],
    } as unknown as Awaited<ReturnType<typeof DocumentPicker.getDocumentAsync>>);

    const candidates = await pickWithSheetSelection(2);
    expect(candidates[0]?.mimeType).toBe('application/octet-stream');
  });

  it('returns an empty list on cancel', async () => {
    getDocumentAsyncMock.mockResolvedValueOnce({
      canceled: true,
      assets: [],
    } as unknown as Awaited<ReturnType<typeof DocumentPicker.getDocumentAsync>>);

    // Cancel is button index 3; Files (2) with a canceled document result
    // also yields []. Use Files so the document path is exercised.
    expect(await pickWithSheetSelection(2)).toEqual([]);
  });
});
