import * as Clipboard from 'expo-clipboard';
import * as Crypto from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';

/**
 * `getImageAsync({ format: 'png' })` re-encodes a copied JPEG as PNG.
 * A large photo can grow past the 20 MB agent cap or the 10 MiB kilo-chat cap,
 * and is then rejected with the same toast as an oversized pick. Screenshots,
 * the dominant paste case, are already PNG.
 */

export type ParsedClipboardImage = {
  base64: string;
  mimeType: 'image/png' | 'image/jpeg';
  extension: 'png' | 'jpg';
};

/**
 * Parse a `data:<mime>;base64,<payload>` string returned by
 * `expo-clipboard`'s `getImageAsync`. Accepts only PNG and JPEG.
 * Returns `null` for every unsupported or empty input. Never throws.
 */
export function parseClipboardImageData(data: string): ParsedClipboardImage | null {
  const prefixEnd = data.indexOf(',');
  if (prefixEnd === -1) {
    return null;
  }
  const header = data.slice(0, prefixEnd);
  const payload = data.slice(prefixEnd + 1).trim();

  if (header === 'data:image/png;base64') {
    if (payload.length === 0) {
      return null;
    }
    return { base64: payload, mimeType: 'image/png', extension: 'png' };
  }

  if (header === 'data:image/jpeg;base64') {
    // Defensive branch. `readClipboardImageFile` always requests
    // `format: 'png'`, so this branch is unreachable in production.
    // Kept so the parser stays honest if the requested format changes.
    if (payload.length === 0) {
      return null;
    }
    return { base64: payload, mimeType: 'image/jpeg', extension: 'jpg' };
  }

  return null;
}

/**
 * Check whether the clipboard holds an image of any type.
 * Uses `hasImageAsync`, which inspects only the content type and raises
 * no iOS paste-permission prompt. Returns `false` on any error.
 */
export async function hasClipboardImage(): Promise<boolean> {
  try {
    return await Clipboard.hasImageAsync();
  } catch {
    return false;
  }
}

/**
 * Check whether the clipboard holds text of any type.
 * Uses `hasStringAsync`, which inspects only the content type and raises
 * no iOS paste-permission prompt. Returns `false` on any error.
 */
export async function hasClipboardText(): Promise<boolean> {
  try {
    return await Clipboard.hasStringAsync();
  } catch {
    return false;
  }
}

/**
 * Check whether the clipboard holds a URL.
 * Uses `hasUrlAsync`, which is iOS/macOS only and raises no iOS paste
 * prompt. Returns `false` on any error (including the Android
 * `UnavailabilityError`).
 */
export async function hasClipboardUrl(): Promise<boolean> {
  try {
    return await Clipboard.hasUrlAsync();
  } catch {
    return false;
  }
}

/**
 * Read the clipboard text. Returns `''` when the clipboard holds no text,
 * the read was denied, or the read failed.
 */
export async function readClipboardText(): Promise<string> {
  try {
    return await Clipboard.getStringAsync();
  } catch {
    return '';
  }
}

export type ClipboardImageFile = { uri: string; name: string; mimeType: string };

/**
 * Read the clipboard image into a cache file.
 *
 * 1. Requests a PNG (`format: 'png'`) from the clipboard.
 * 2. Parses the returned data URI.
 * 3. Writes the decoded base64 payload into `Paths.cache/clipboard-images/`
 *    through the modern `expo-file-system` API.
 *
 * Returns `null` on every failure: clipboard empty, permission denied,
 * unsupported type, or a write error.
 */
export async function readClipboardImageFile(): Promise<ClipboardImageFile | null> {
  try {
    const image = await Clipboard.getImageAsync({ format: 'png' });
    if (!image) {
      return null;
    }
    const parsed = parseClipboardImageData(image.data);
    if (!parsed) {
      return null;
    }
    const directory = new Directory(Paths.cache, 'clipboard-images');
    directory.create({ idempotent: true, intermediates: true });
    const filename = `pasted-image-${Crypto.randomUUID()}.${parsed.extension}`;
    const file = new File(directory, filename);
    file.write(parsed.base64, { encoding: 'base64' });
    return {
      uri: file.uri,
      name: `pasted-image.${parsed.extension}`,
      mimeType: parsed.mimeType,
    };
  } catch {
    return null;
  }
}
