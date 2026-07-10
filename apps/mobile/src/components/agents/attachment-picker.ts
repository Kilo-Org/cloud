/* eslint-disable @typescript-eslint/promise-function-async, require-await -- This module wraps Alert.alert and select-style pickers in Promise-returning helpers, so require-await and promise-function-async apply; prefer-await-to-then still applies inside the body. */
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { type ActionSheetProps } from '@expo/react-native-action-sheet';
import { Alert, Linking } from 'react-native';

import {
  AGENT_ATTACHMENT_MIME_BY_EXTENSION,
  type AgentAttachmentExtension,
} from '@/lib/agent-attachments/constants';
import { type AgentAttachmentCandidate } from '@/lib/agent-attachments/use-agent-attachment-upload';
import { classifyAttachment } from '@/lib/agent-attachments/validate';

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

function mimeTypeForExtension(extension: AgentAttachmentExtension): string {
  return AGENT_ATTACHMENT_MIME_BY_EXTENSION[extension];
}

function normalizeImageAsset(asset: {
  uri: string;
  fileName?: string | null;
  mimeType?: string | null;
  fileSize?: number | null;
}): AgentAttachmentCandidate {
  const name = asset.fileName ?? `image.${(asset.mimeType ?? 'image/png').split('/')[1] ?? 'png'}`;
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
  const dot = asset.name.lastIndexOf('.');
  const ext =
    dot > 0 ? (asset.name.slice(dot + 1).toLowerCase() as AgentAttachmentExtension) : null;
  const mimeType = asset.mimeType ?? (ext ? mimeTypeForExtension(ext) : undefined);
  return {
    name: asset.name,
    uri: asset.uri,
    mimeType,
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
  return result.assets.map(normalizeImageAsset).filter(asset => {
    const classified = classifyAttachment(asset);
    return classified.ok;
  });
}

async function pickAgentLibraryImages(): Promise<AgentAttachmentCandidate[]> {
  const result = await ImagePicker.launchImageLibraryAsync({
    ...IMAGE_PICKER_OPTIONS,
    allowsMultipleSelection: true,
  });
  if (result.canceled) {
    return [];
  }
  return result.assets.map(normalizeImageAsset).filter(asset => {
    const classified = classifyAttachment(asset);
    return classified.ok;
  });
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
  return result.assets.map(normalizeDocumentAsset).filter(asset => {
    const classified = classifyAttachment(asset);
    return classified.ok;
  });
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
