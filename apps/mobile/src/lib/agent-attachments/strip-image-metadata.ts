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
 * the format-matched re-encode fails, PNG and WebP inputs retry once with a
 * forced JPEG output (the one format every platform's encoder supports);
 * JPEG-family inputs (jpg, jpeg, gif, heic, heif) already encode to JPEG and
 * keep their single attempt. Only a total failure says so in the result — the
 * original URI is never returned as a success value, so a caller can never
 * treat an unstripped image as sanitized.
 */
export async function stripImageMetadata(
  uri: string,
  extension: AgentAttachmentExtension
): Promise<StripImageMetadataResult> {
  let lastError: unknown = undefined;
  try {
    // eslint-disable-next-line typescript-eslint/no-deprecated -- manipulateAsync is the documented no-op re-encode; the contextual API adds no benefit for a zero-transformation re-encode
    const result = await ImageManipulator.manipulateAsync(uri, [], {
      compress: 1,
      format: saveFormatFor(extension),
    });
    return { ok: true, uri: result.uri, extension: strippedExtension(extension) };
  } catch (firstError) {
    lastError = firstError;
    // JPEG-family inputs (jpg, jpeg, gif, heic, heif) already encode to JPEG,
    // so the retry would repeat the identical call and pay a second full
    // decode/encode for a deterministic failure. Only a PNG or WebP encode
    // has an untried fallback left.
    if (saveFormatFor(extension) !== ImageManipulator.SaveFormat.JPEG) {
      try {
        // eslint-disable-next-line typescript-eslint/no-deprecated -- see above
        const result = await ImageManipulator.manipulateAsync(uri, [], {
          compress: 1,
          format: ImageManipulator.SaveFormat.JPEG,
        });
        return { ok: true, uri: result.uri, extension: 'jpg' };
      } catch (retryError) {
        lastError = retryError;
      }
    }
    Sentry.captureException(
      new Error('Attachment image metadata strip failed', { cause: lastError }),
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
