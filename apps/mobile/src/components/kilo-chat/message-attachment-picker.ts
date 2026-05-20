import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import { type AddFileInput } from '@kilocode/kilo-chat-hooks';

import {
  type NativeAttachmentSelection,
  normalizeAttachmentSelection,
} from './message-attachment-state';

export type LocalAttachmentAsset = NativeAttachmentSelection;

const IMAGE_PICKER_OPTIONS = {
  mediaTypes: ['images'],
  quality: 1,
} satisfies ImagePicker.ImagePickerOptions;

export function assetToAddFileInput(asset: LocalAttachmentAsset): AddFileInput {
  const file = new File(asset.uri);
  const attachment = normalizeAttachmentSelection({
    uri: asset.uri,
    name: asset.name,
    fileName: asset.fileName ?? file.name,
    mimeType: asset.mimeType ?? file.type,
    size: asset.size ?? asset.fileSize ?? file.size,
    fileSize: asset.fileSize,
  });

  return {
    blob: file,
    filename: attachment.filename,
    mimeType: attachment.mimeType,
  };
}

export async function pickCameraImage(): Promise<AddFileInput[]> {
  const permission = await ImagePicker.requestCameraPermissionsAsync();
  if (!permission.granted) {
    throw new Error(
      'Camera access is required to take a photo. Enable it in Settings and try again.'
    );
  }

  const result = await ImagePicker.launchCameraAsync(IMAGE_PICKER_OPTIONS);

  if (result.canceled) {
    return [];
  }

  return Promise.all(
    result.assets.map(asset =>
      assetToAddFileInput({
        uri: asset.uri,
        fileName: asset.fileName,
        mimeType: asset.mimeType,
        fileSize: asset.fileSize,
      })
    )
  );
}

export async function pickLibraryImages(): Promise<AddFileInput[]> {
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) {
    throw new Error(
      'Photo library access is required to attach images. Enable it in Settings and try again.'
    );
  }

  const result = await ImagePicker.launchImageLibraryAsync({
    ...IMAGE_PICKER_OPTIONS,
    allowsMultipleSelection: true,
  });

  if (result.canceled) {
    return [];
  }

  return Promise.all(
    result.assets.map(asset =>
      assetToAddFileInput({
        uri: asset.uri,
        fileName: asset.fileName,
        mimeType: asset.mimeType,
        fileSize: asset.fileSize,
      })
    )
  );
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

  return Promise.all(
    result.assets.map(asset =>
      assetToAddFileInput({
        uri: asset.uri,
        name: asset.name,
        mimeType: asset.mimeType,
        size: asset.size,
      })
    )
  );
}
