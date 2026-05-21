import { type AlertButton } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { pickCameraImage, pickLibraryImages } from './message-attachment-picker';

const fileSystemMock = vi.hoisted(() => ({
  File: vi.fn(function File(this: { name: string; size: number; type: string }, uri: string) {
    this.name = uri.split('/').at(-1) ?? 'attachment';
    this.size = 12;
    this.type = 'image/jpeg';
  }),
}));

const reactNativeMock = vi.hoisted(() => ({
  alert: vi.fn(),
  openSettings: vi.fn(),
}));

vi.mock('react-native', () => ({
  Alert: { alert: reactNativeMock.alert },
  Linking: { openSettings: reactNativeMock.openSettings },
}));

vi.mock('expo-file-system', () => ({
  File: fileSystemMock.File,
}));

vi.mock('expo-document-picker', () => ({
  getDocumentAsync: vi.fn(),
}));

vi.mock('expo-image-picker', () => ({
  launchCameraAsync: vi.fn(),
  launchImageLibraryAsync: vi.fn(),
  PermissionStatus: { DENIED: 'denied' },
  requestCameraPermissionsAsync: vi.fn(),
  requestMediaLibraryPermissionsAsync: vi.fn(),
}));

const requestCameraPermissionsMock = vi.mocked(ImagePicker.requestCameraPermissionsAsync);
const requestMediaLibraryPermissionsMock = vi.mocked(
  ImagePicker.requestMediaLibraryPermissionsAsync
);
const launchCameraMock = vi.mocked(ImagePicker.launchCameraAsync);
const launchImageLibraryMock = vi.mocked(ImagePicker.launchImageLibraryAsync);

function deniedPermissionResponse(): ImagePicker.PermissionResponse {
  return {
    canAskAgain: false,
    expires: 'never',
    granted: false,
    status: ImagePicker.PermissionStatus.DENIED,
  };
}

describe('message attachment picker permissions', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.fetch = vi.fn(async () => {
      await Promise.resolve();
      return new Response(new Blob(['x'], { type: 'image/jpeg' }));
    }) as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('shows settings alert and skips camera launch when camera permission is denied', async () => {
    requestCameraPermissionsMock.mockResolvedValue(deniedPermissionResponse());

    const result = await pickCameraImage();

    expect(result).toEqual([]);
    expect(launchCameraMock).not.toHaveBeenCalled();
    expect(reactNativeMock.alert).toHaveBeenCalledWith(
      'Camera Access Disabled',
      'Allow camera access in Settings to take a photo.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Open Settings', onPress: expect.any(Function) },
      ]
    );

    const actions = reactNativeMock.alert.mock.calls[0]?.[2] as AlertButton[] | undefined;
    actions?.[1]?.onPress?.();
    expect(reactNativeMock.openSettings).toHaveBeenCalledTimes(1);
  });

  it('launches the library picker without preflighting photo library permission', async () => {
    requestMediaLibraryPermissionsMock.mockResolvedValue(deniedPermissionResponse());
    launchImageLibraryMock.mockResolvedValue({
      assets: [
        {
          uri: 'file:///photo.jpg',
          fileName: 'photo.jpg',
          mimeType: 'image/jpeg',
          fileSize: 42,
          height: 100,
          width: 100,
        },
      ],
      canceled: false,
    });

    const result = await pickLibraryImages();

    expect(requestMediaLibraryPermissionsMock).not.toHaveBeenCalled();
    expect(launchImageLibraryMock).toHaveBeenCalledWith({
      mediaTypes: ['images'],
      quality: 1,
      allowsMultipleSelection: true,
    });
    expect(reactNativeMock.alert).not.toHaveBeenCalled();
    expect(result).toEqual([
      {
        input: {
          blob: expect.objectContaining({ type: 'image/jpeg' }),
          filename: 'photo.jpg',
          mimeType: 'image/jpeg',
        },
        localUri: 'file:///photo.jpg',
      },
    ]);
  });
});
