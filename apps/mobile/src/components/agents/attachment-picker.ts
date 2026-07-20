/* eslint-disable @typescript-eslint/promise-function-async, require-await -- This module wraps Alert.alert and select-style pickers in Promise-returning helpers, so require-await and promise-function-async apply; prefer-await-to-then still applies inside the body. */
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { type ActionSheetProps } from '@expo/react-native-action-sheet';
import { Alert, Linking } from 'react-native';

import { mimeForExtension, normalizeAttachmentExtension } from '@/lib/agent-attachments/validate';
import { type AgentAttachmentCandidate } from '@/lib/agent-attachments/use-agent-attachment-upload';

const IMAGE_PICKER_OPTIONS = {
  mediaTypes: ['images'],
  quality: 1,
} satisfies ImagePicker.ImagePickerOptions;

function showPermissionSettingsAlert({ message, title }: { message: string; title: string }) {
  Alert.alert(title, message, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Open Settings', onPress: () => void Linking.openSettings() },
  ]);
}

function normalizeImageAsset(asset: {
  uri: string;
  fileName?: string | null;
  mimeType?: string | null;
  fileSize?: number | null;
}): AgentAttachmentCandidate {
  // Image picker cannot return a filename with an arbitrary extension;
  // synthesize one from the picker's MIME so `normalizeAttachmentExtension`
  // can resolve a known key. The actual byte size is re-measured by the
  // upload hook via `getInfoAsync`; `size` here is informational.
  const fallbackName = `image.${(asset.mimeType ?? 'image/png').split('/')[1] ?? 'png'}`;
  const name = asset.fileName ?? fallbackName;
  return {
    name,
    uri: asset.uri,
    mimeType: asset.mimeType ?? undefined,
    size: asset.fileSize ?? undefined,
  };
}

function normalizeDocumentAsset(asset: {
  uri: string;
  name: string;
  mimeType?: string;
  size?: number;
}): AgentAttachmentCandidate {
  // The picker MIME is intentionally NOT consulted. The cloud-agent
  // storage layer rejects anything outside the canonical extension
  // table, and iOS pickers report `application/octet-stream` for any
  // extension the platform doesn't ship a UTI for. Resolving MIME from
  // the extension makes the picker → upload hook contract exact.
  const extension = normalizeAttachmentExtension(asset.name);
  return {
    name: asset.name,
    uri: asset.uri,
    // The candidate shape carries MIME for kilochat-picker parity, but
    // the agent-attachments classifier ignores it and re-derives from
    // the extension. No closed-union cast — the extension is whatever
    // survives `normalizeAttachmentExtension`, including the `bin`
    // fallback.
    mimeType: mimeForExtension(extension),
    size: asset.size,
  };
}

async function pickAgentCameraImage(): Promise<AgentAttachmentCandidate[]> {
  const permission = await ImagePicker.requestCameraPermissionsAsync();
  if (!permission.granted) {
    showPermissionSettingsAlert({
      title: 'Camera Access Disabled',
      message: 'Allow camera access in Settings to take a photo.',
    });
    return [];
  }
  const result = await ImagePicker.launchCameraAsync(IMAGE_PICKER_OPTIONS);
  if (result.canceled) {
    return [];
  }
  return result.assets.map(normalizeImageAsset);
}

async function pickAgentLibraryImages(): Promise<AgentAttachmentCandidate[]> {
  const result = await ImagePicker.launchImageLibraryAsync({
    ...IMAGE_PICKER_OPTIONS,
    allowsMultipleSelection: true,
  });
  if (result.canceled) {
    return [];
  }
  return result.assets.map(normalizeImageAsset);
}

async function pickAgentDocuments(): Promise<AgentAttachmentCandidate[]> {
  const result = await DocumentPicker.getDocumentAsync({
    copyToCacheDirectory: true,
    multiple: true,
    type: '*/*',
  });
  if (result.canceled) {
    return [];
  }
  return result.assets.map(normalizeDocumentAsset);
}

type AttachmentSource = 'camera' | 'library' | 'files';

const ATTACHMENT_SOURCE_OPTIONS = ['Camera', 'Photo Library', 'Files', 'Cancel'];
const ATTACHMENT_SOURCE_CANCEL_INDEX = ATTACHMENT_SOURCE_OPTIONS.length - 1;

async function pickFromSource(source: AttachmentSource): Promise<AgentAttachmentCandidate[]> {
  if (source === 'camera') {
    return pickAgentCameraImage();
  }
  if (source === 'library') {
    return pickAgentLibraryImages();
  }
  return pickAgentDocuments();
}

export function pickAgentAttachments(
  showActionSheetWithOptions: ActionSheetProps['showActionSheetWithOptions']
): Promise<AgentAttachmentCandidate[]> {
  return new Promise(resolve => {
    let settled = false;
    const settle = (value: AgentAttachmentCandidate[]) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    const handle = async (source: AttachmentSource) => {
      const result = await pickFromSource(source);
      settle(result);
    };
    showActionSheetWithOptions(
      {
        options: ATTACHMENT_SOURCE_OPTIONS,
        cancelButtonIndex: ATTACHMENT_SOURCE_CANCEL_INDEX,
      },
      index => {
        if (index === 0) {
          void handle('camera');
        } else if (index === 1) {
          void handle('library');
        } else if (index === 2) {
          void handle('files');
        } else {
          settle([]);
        }
      }
    );
  });
}
