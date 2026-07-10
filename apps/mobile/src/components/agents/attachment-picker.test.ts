import { type ActionSheetProps } from '@expo/react-native-action-sheet';
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

describe('agent attachment picker', () => {
  it('opens a native action sheet that keeps all sources and the cancel action', () => {
    const showActionSheet: ActionSheetProps['showActionSheetWithOptions'] = vi.fn(
      (_options, _callback) => undefined
    );

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
