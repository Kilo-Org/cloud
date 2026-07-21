import { type ActionSheetProps } from '@expo/react-native-action-sheet';
import * as DocumentPicker from 'expo-document-picker';
import { describe, expect, it, vi } from 'vitest';

import { pickAgentAttachments } from './attachment-picker';

const reactNativeMock = vi.hoisted(() => ({
  alert: vi.fn(),
  openSettings: vi.fn(),
}));

vi.mock('react-native', () => ({
  Alert: { alert: reactNativeMock.alert },
  Linking: { openSettings: reactNativeMock.openSettings },
}));

vi.mock('expo-document-picker', () => ({
  getDocumentAsync: vi.fn(),
}));

vi.mock('expo-image-picker', () => ({
  launchCameraAsync: vi.fn(),
  launchImageLibraryAsync: vi.fn(),
  requestCameraPermissionsAsync: vi.fn(),
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
  const resultPromise = pickAgentAttachments(showActionSheet);
  const registered = showActionSheet.mock.calls[0]?.[1];
  expect(registered).toEqual(expect.any(Function));
  await Promise.resolve(registered?.(buttonIndex));
  return resultPromise;
}

describe('agent attachment picker', () => {
  it('opens a native action sheet that keeps all sources and the cancel action', () => {
    const showActionSheet = vi.fn() as unknown as ShowActionSheet & {
      mock: { calls: unknown[][] };
    };

    void pickAgentAttachments(showActionSheet);

    expect(showActionSheet).toHaveBeenCalledWith(
      {
        options: ['Camera', 'Photo Library', 'Files', 'Cancel'],
        cancelButtonIndex: 3,
      },
      expect.any(Function)
    );
    expect(reactNativeMock.alert).not.toHaveBeenCalled();
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
