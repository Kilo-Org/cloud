import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import { Alert, Linking } from 'react-native';
import { type AddFileInput } from '@kilocode/kilo-chat-hooks';

import {
  type NativeAttachmentSelection,
  normalizeAttachmentSelection,
} from './message-attachment-state';

type LocalAttachmentAsset = NativeAttachmentSelection;

const IMAGE_PICKER_OPTIONS = {
  mediaTypes: ['images'],
  quality: 1,
} satisfies ImagePicker.ImagePickerOptions;

async function assetToAddFileInput(asset: LocalAttachmentAsset): Promise<AddFileInput> {
  const file = new File(asset.uri);
  const attachment = normalizeAttachmentSelection({
    uri: asset.uri,
    name: asset.name,
    fileName: asset.fileName ?? file.name,
    mimeType: asset.mimeType ?? file.type,
    size: asset.size ?? asset.fileSize ?? file.size,
    fileSize: asset.fileSize,
  });

  // expo-file-system's `File` is not a `Blob`, so XHR's `send(...)` cannot
  // upload it. Materialize a real `Blob` from the file:// URI here so the
  // upload PUT carries the correct body and matches the signed Content-Length.
  const response = await fetch(asset.uri);
  const blob = await response.blob();

  return {
    blob,
    filename: attachment.filename,
    mimeType: attachment.mimeType,
  };
}

function showPermissionSettingsAlert({ message, title }: { message: string; title: string }) {
  Alert.alert(title, message, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Open Settings', onPress: () => void Linking.openSettings() },
  ]);
}

export async function pickCameraImage(): Promise<AddFileInput[]> {
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

  return Promise.all(result.assets.map(imageAssetToInput));
}

export async function pickLibraryImages(): Promise<AddFileInput[]> {
  const result = await ImagePicker.launchImageLibraryAsync({
    ...IMAGE_PICKER_OPTIONS,
    allowsMultipleSelection: true,
  });

  if (result.canceled) {
    return [];
  }

  return Promise.all(result.assets.map(imageAssetToInput));
}

export async function pickFiles(): Promise<AddFileInput[]> {
  const result = await DocumentPicker.getDocumentAsync({
    copyToCacheDirectory: true,
    multiple: true,
    type: '*/*',
  });

  if (result.canceled) {
    return [];
  }

  return Promise.all(result.assets.map(documentAssetToInput));
}

// eslint-disable-next-line typescript-eslint/promise-function-async -- thin pass-through; making it async only to satisfy this rule conflicts with `require-await`.
function imageAssetToInput(asset: {
  uri: string;
  fileName?: string | null;
  mimeType?: string | null;
  fileSize?: number | null;
}): Promise<AddFileInput> {
  return assetToAddFileInput({
    uri: asset.uri,
    fileName: asset.fileName,
    mimeType: asset.mimeType,
    fileSize: asset.fileSize,
  });
}

// eslint-disable-next-line typescript-eslint/promise-function-async -- thin pass-through; making it async only to satisfy this rule conflicts with `require-await`.
function documentAssetToInput(asset: {
  uri: string;
  name: string;
  mimeType?: string;
  size?: number;
}): Promise<AddFileInput> {
  return assetToAddFileInput({
    uri: asset.uri,
    name: asset.name,
    mimeType: asset.mimeType,
    size: asset.size,
  });
}
