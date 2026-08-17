import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import { Alert, Linking } from 'react-native';
import { type AddFileInput } from '@kilocode/kilo-chat-hooks';

import { type ClipboardImageFile } from '@/lib/agent-attachments/clipboard-image';
import { IMAGE_PICKER_OPTIONS, launchImagePicker } from '@/lib/agent-attachments/image-picker';

import {
  type MessageAttachment,
  type NativeAttachmentSelection,
  normalizeAttachmentSelection,
} from './message-attachment-state';

type LocalAttachmentAsset = NativeAttachmentSelection;

export type PickedAttachment = {
  input: AddFileInput;
  localUri: string;
};

function assetToSelection(asset: LocalAttachmentAsset): MessageAttachment {
  const file = new File(asset.uri);
  return normalizeAttachmentSelection({
    uri: asset.uri,
    name: asset.name,
    fileName: asset.fileName ?? file.name,
    mimeType: asset.mimeType ?? file.type,
    // Never trust the smaller number. `File.size` is `0` when the file does not
    // exist or cannot be read, and picker-reported sizes are unreliable (the
    // cloud-agent path re-measures for the same reason, see
    // `lib/agent-attachments/validate.ts`). Taking the max keeps the gate
    // fail-closed both ways: an unreadable file with no reported size lands on
    // 0 and is rejected before any bytes are read, and a file the picker
    // reports as larger than the stat is judged on the larger figure.
    size: Math.max(file.size, asset.size ?? 0, asset.fileSize ?? 0),
    fileSize: asset.fileSize,
  });
}

/**
 * Materialize a real `Blob` from the file:// URI so the upload PUT carries the
 * correct body and matches the signed Content-Length. expo/fetch (global since
 * SDK 56) supports file:// on iOS (NativeResponse.swift) and Android
 * (OkHttpFileUrlInterceptor.kt); File implements Blob but XHR still needs a
 * store-backed Blob for the signed PUT.
 *
 * Only ever called for attachments that already passed
 * `selectAllowedAttachments` — this reads the whole file into memory.
 */
export async function materializeAttachment(
  attachment: MessageAttachment
): Promise<PickedAttachment> {
  const response = await fetch(attachment.uri);
  const blob = await response.blob();
  return {
    input: { blob, filename: attachment.filename, mimeType: attachment.mimeType },
    localUri: attachment.uri,
  };
}

export function clipboardImageToSelection(file: ClipboardImageFile): MessageAttachment {
  return assetToSelection({
    uri: file.uri,
    name: file.name,
    mimeType: file.mimeType,
  });
}

function showPermissionSettingsAlert({ message, title }: { message: string; title: string }) {
  Alert.alert(title, message, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Open Settings', onPress: () => void Linking.openSettings() },
  ]);
}

export async function pickCameraImage(): Promise<MessageAttachment[]> {
  const permission = await ImagePicker.requestCameraPermissionsAsync();
  if (!permission.granted) {
    showPermissionSettingsAlert({
      title: 'Camera Access Disabled',
      message: 'Allow camera access in Settings to take a photo.',
    });
    return [];
  }

  const assets = await launchImagePicker(ImagePicker.launchCameraAsync(IMAGE_PICKER_OPTIONS));

  return assets.map(asset => imageAssetToSelection(asset));
}

export async function pickLibraryImages(): Promise<MessageAttachment[]> {
  const assets = await launchImagePicker(
    ImagePicker.launchImageLibraryAsync({
      ...IMAGE_PICKER_OPTIONS,
      allowsMultipleSelection: true,
    })
  );

  return assets.map(asset => imageAssetToSelection(asset));
}

export async function pickFiles(): Promise<MessageAttachment[]> {
  const result = await DocumentPicker.getDocumentAsync({
    copyToCacheDirectory: true,
    multiple: true,
    type: '*/*',
  });

  if (result.canceled) {
    return [];
  }

  return result.assets.map(documentAssetToSelection);
}

function imageAssetToSelection(asset: {
  uri: string;
  fileName?: string | null;
  mimeType?: string | null;
  fileSize?: number | null;
}): MessageAttachment {
  return assetToSelection({
    uri: asset.uri,
    fileName: asset.fileName,
    mimeType: asset.mimeType,
    fileSize: asset.fileSize,
  });
}

function documentAssetToSelection(asset: {
  uri: string;
  name: string;
  mimeType?: string;
  size?: number;
}): MessageAttachment {
  return assetToSelection({
    uri: asset.uri,
    name: asset.name,
    mimeType: asset.mimeType,
    size: asset.size,
  });
}
