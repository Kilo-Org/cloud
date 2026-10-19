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

export type StripImageMetadataResult =
  | { ok: true; uri: string; extension: AgentAttachmentExtension }
  | { ok: false };

/**
 * Re-encode an image with no operations, which drops EXIF, GPS, and maker
 * notes. Returns the new cache URI and the extension of the produced file. If
 * the format-matched re-encode fails, retries once with a forced JPEG output
 * (the one format every platform's encoder supports). Only when that retry
 * also fails does the result say so — the original URI is never returned as a
 * success value, so a caller can never treat an unstripped image as sanitized.
 */
export async function stripImageMetadata(
  uri: string,
  extension: AgentAttachmentExtension
): Promise<StripImageMetadataResult> {
  try {
    // eslint-disable-next-line typescript-eslint/no-deprecated -- manipulateAsync is the documented no-op re-encode; the contextual API adds no benefit for a zero-transformation re-encode
    const result = await ImageManipulator.manipulateAsync(uri, [], {
      compress: 1,
      format: saveFormatFor(extension),
    });
    return { ok: true, uri: result.uri, extension: strippedExtension(extension) };
  } catch {
    try {
      // eslint-disable-next-line typescript-eslint/no-deprecated -- see above
      const result = await ImageManipulator.manipulateAsync(uri, [], {
        compress: 1,
        format: ImageManipulator.SaveFormat.JPEG,
      });
      return { ok: true, uri: result.uri, extension: 'jpg' };
    } catch (retryError) {
      Sentry.captureException(
        new Error('Attachment image metadata strip failed', { cause: retryError }),
        {
          tags: {
            'error.subsystem': 'agent-attachments',
            'error.operation': 'strip-image-metadata',
          },
          extra: { inputExtension: extension },
          fingerprint: ['agent-attachments-strip-image-metadata', extension],
        }
      );
      return { ok: false };
    }
  }
}
