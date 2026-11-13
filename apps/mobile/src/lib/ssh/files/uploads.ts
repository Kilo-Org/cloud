import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';

export type PickedFile = Readonly<{ uri: string; name: string }>;

/** The files the person picked from the system file picker, or null if none. */
export async function pickDocuments(): Promise<PickedFile[] | null> {
  const result = await DocumentPicker.getDocumentAsync({
    multiple: true,
    copyToCacheDirectory: true,
  });
  if (result.canceled) {
    return null;
  }
  return result.assets.map(asset => ({ uri: asset.uri, name: asset.name }));
}

/** The photos the person picked from their library, or null if none. */
export async function pickPhotos(): Promise<PickedFile[] | null> {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsMultipleSelection: true,
    quality: 1,
  });
  if (result.canceled) {
    return null;
  }
  return result.assets.map((asset, index) => ({
    uri: asset.uri,
    name: asset.fileName ?? `photo-${Date.now()}-${index}.jpg`,
  }));
}
