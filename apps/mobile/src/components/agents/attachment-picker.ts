/* eslint-disable @typescript-eslint/promise-function-async, require-await -- This module wraps Alert.alert and select-style pickers in Promise-returning helpers, so require-await and promise-function-async apply; prefer-await-to-then still applies inside the body. */
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { type ActionSheetProps } from '@expo/react-native-action-sheet';
import { Alert, Linking } from 'react-native';
import * as Sentry from '@sentry/react-native';

import { AGENT_ATTACHMENT_EXTENSION_REGEX } from '@/lib/agent-attachments/constants';
import { mimeForExtension, normalizeAttachmentExtension } from '@/lib/agent-attachments/validate';
import { IMAGE_PICKER_OPTIONS, launchImagePicker } from '@/lib/agent-attachments/image-picker';
import { writePickerLaunchContext } from '@/lib/agent-attachments/picker-launch-context';
import { type AgentAttachmentCandidate } from '@/lib/agent-attachments/use-agent-attachment-upload';

function showPermissionSettingsAlert({ message, title }: { message: string; title: string }) {
  Alert.alert(title, message, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Open Settings', onPress: () => void Linking.openSettings() },
  ]);
}

export function normalizeImageAsset(asset: {
  uri: string;
  fileName?: string | null;
  mimeType?: string | null;
  fileSize?: number | null;
}): AgentAttachmentCandidate {
  // Keep the picker's filename when it is non-empty after trimming.
  const fileName = asset.fileName?.trim();
  if (fileName) {
    return {
      name: fileName,
      uri: asset.uri,
      mimeType: asset.mimeType ?? undefined,
      size: asset.fileSize ?? undefined,
    };
  }

  // The image picker can omit the filename — camera HEIC assets report
  // `application/octet-stream` with no name. Synthesize `image.<ext>` from
  // the URI extension, then the MIME subtype, then fall back to `image.png`.
  // The upload hook re-measures size via `getInfoAsync`; `size` here is
  // informational.
  const uriExtension = asset.uri.split('.').pop()?.toLowerCase();
  const mimeSubtype = asset.mimeType?.split('/')[1]?.toLowerCase();
  const extension =
    (uriExtension && AGENT_ATTACHMENT_EXTENSION_REGEX.test(uriExtension) ? uriExtension : null) ??
    (mimeSubtype && AGENT_ATTACHMENT_EXTENSION_REGEX.test(mimeSubtype) ? mimeSubtype : null) ??
    'png';
  return {
    name: `image.${extension}`,
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
  const assets = await launchImagePicker(ImagePicker.launchCameraAsync(IMAGE_PICKER_OPTIONS));
  return assets.map(asset => normalizeImageAsset(asset));
}

async function pickAgentLibraryImages(): Promise<AgentAttachmentCandidate[]> {
  const assets = await launchImagePicker(
    ImagePicker.launchImageLibraryAsync({
      ...IMAGE_PICKER_OPTIONS,
      allowsMultipleSelection: true,
    })
  );
  return assets.map(asset => normalizeImageAsset(asset));
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
  showActionSheetWithOptions: ActionSheetProps['showActionSheetWithOptions'],
  context: {
    userId: string | undefined;
    surface: 'agent-new' | 'agent-chat';
    sessionId: string | null;
  }
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
      // Record the launching composer + account before the camera/library
      // launch so the recovery hook can match a pending result after an
      // Activity recreation. NOT before the Files branch, which uses
      // `startActivityForResult` and is unaffected by that bug.
      // Record the launching composer + account before the camera/library
      // launch so the recovery hook can match a pending result after an
      // Activity recreation. NOT before the Files branch, which uses
      // `startActivityForResult` and is unaffected by that bug. Only record
      // the launch when a real user id is present; an empty id would store a
      // context the recovery hook can never match.
      if ((source === 'camera' || source === 'library') && context.userId) {
        try {
          await writePickerLaunchContext({
            userId: context.userId,
            surface: context.surface,
            sessionId: context.sessionId,
            launchedAt: Date.now(),
          });
        } catch (error) {
          // A store write failure must not block the picker launch; the
          // recovery hook simply finds no context and nothing is attached.
          Sentry.captureException(error);
        }
      }
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
