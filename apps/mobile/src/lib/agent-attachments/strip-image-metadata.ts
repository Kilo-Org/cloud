import * as ImageManipulator from 'expo-image-manipulator';
import * as Sentry from '@sentry/react-native';

import { type AgentAttachmentExtension } from './constants';

/**
 * Output extension after a metadata strip. PNG and WebP re-encode to their own
 * format; every other image (JPEG, GIF) re-encodes to JPEG.
 */
export function strippedExtension(extension: AgentAttachmentExtension): AgentAttachmentExtension {
  if (extension === 'png') {
    return 'png';
  }
  if (extension === 'webp') {
    return 'webp';
  }
  return 'jpg';
}

function saveFormatFor(extension: AgentAttachmentExtension): ImageManipulator.SaveFormat {
  if (extension === 'png') {
    return ImageManipulator.SaveFormat.PNG;
  }
  if (extension === 'webp') {
    return ImageManipulator.SaveFormat.WEBP;
  }
  return ImageManipulator.SaveFormat.JPEG;
}

/**
 * Re-encode an image with no operations, which drops EXIF, GPS, and maker
 * notes. Returns the new cache URI. On failure it reports to Sentry and
 * returns the original URI so the caller keeps the unmodified file.
 */
export async function stripImageMetadata(
  uri: string,
  extension: AgentAttachmentExtension
): Promise<string> {
  try {
    // eslint-disable-next-line typescript-eslint/no-deprecated -- manipulateAsync is the documented no-op re-encode; the contextual API adds no benefit for a zero-transformation re-encode
    const result = await ImageManipulator.manipulateAsync(uri, [], {
      compress: 1,
      format: saveFormatFor(extension),
    });
    return result.uri;
  } catch (error) {
    Sentry.captureException(error);
    return uri;
  }
}
