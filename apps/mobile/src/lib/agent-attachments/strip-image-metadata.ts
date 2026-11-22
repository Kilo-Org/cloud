import * as ImageManipulator from 'expo-image-manipulator';
import * as Sentry from '@sentry/react-native';
import { z } from 'zod';

import { AGENT_ATTACHMENT_IMAGE_MAX_EDGE, type AgentAttachmentExtension } from './constants';

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

/** Fingerprint parts stay short so grouping is stable and the event stays small. */
const MAX_FINGERPRINT_PART_LENGTH = 120;

/** Fingerprint part for a cause that carries neither a code nor a name. */
const UNKNOWN_CAUSE_DETAIL = 'unknown';

/** Expo sets `code` on the errors its native modules reject with. */
const ERROR_CODE_SCHEMA = z.string().min(1);

/**
 * Cause parts for an encoder failure. Its message can carry the picked file
 * URI, so only the Expo error code, then the error name, is used, bounded.
 * Distinct codes therefore keep distinct issues instead of sharing one issue
 * per input extension.
 */
function encoderCause(cause: Error): string[] {
  const parsed = ERROR_CODE_SCHEMA.safeParse('code' in cause ? cause.code : undefined);
  const named = parsed.success ? parsed.data : cause.name;
  const detail = named.length > 0 ? named : UNKNOWN_CAUSE_DETAIL;
  const bounded =
    detail.length > MAX_FINGERPRINT_PART_LENGTH
      ? detail.slice(0, MAX_FINGERPRINT_PART_LENGTH)
      : detail;
  return ['encoder', bounded];
}

/**
 * Decode an image with its longest edge at most `AGENT_ATTACHMENT_IMAGE_MAX_EDGE`
 * and return the rendered image; the caller releases it. The decoder is asked
 * for the bound, but a loader that ignores it would still hand back a
 * full-resolution image, so the rendered size is enforced again here. The
 * resize takes the rendered image rather than the URI: its pixels are already
 * decoded, and reading the file again would put a second full-resolution copy
 * in memory. The intermediate image is released here, including when the
 * resize render fails.
 */
async function renderBounded(uri: string): Promise<ImageManipulator.ImageRef> {
  let live = await ImageManipulator.ImageManipulator.manipulate(uri, {
    maxWidth: AGENT_ATTACHMENT_IMAGE_MAX_EDGE,
    maxHeight: AGENT_ATTACHMENT_IMAGE_MAX_EDGE,
  }).renderAsync();
  const { width, height } = live;
  const scale = Math.min(1, AGENT_ATTACHMENT_IMAGE_MAX_EDGE / Math.max(width, height));
  if (scale < 1) {
    const source = live;
    try {
      live = await ImageManipulator.ImageManipulator.manipulate(source)
        .resize({ width: Math.round(width * scale), height: Math.round(height * scale) })
        .renderAsync();
    } finally {
      source.release();
    }
  }
  return live;
}

/**
 * Re-encode an image with no operations, which drops EXIF, GPS, and maker
 * notes. Each decode is bounded to `AGENT_ATTACHMENT_IMAGE_MAX_EDGE` per edge,
 * and a render whose loader ignored that bound is resized down from the
 * rendered pixels, so a full-resolution photo is never materialized.
 * `ImageRef.saveAsync` writes the image to the cache directory as a new file on
 * every call, so the returned URI is that new cache file and never the input —
 * the original URI is never returned as a success value, and a caller can never
 * treat an unstripped image as sanitized. Returns the saved URI and the
 * extension of the produced file. If the format-matched re-encode fails, PNG
 * and WebP inputs retry once with a forced JPEG output (the one format every
 * platform's encoder supports); JPEG-family inputs (jpg, jpeg, gif, heic, heif)
 * already encode to JPEG and keep their single attempt. Only a total failure
 * says so in the result. The report names the encoder failure in its
 * fingerprint, so distinct causes stay in separate issues.
 */
export async function stripImageMetadata(
  uri: string,
  extension: AgentAttachmentExtension
): Promise<StripImageMetadataResult> {
  let lastError: Error = new Error('Attachment image metadata strip failed');
  const report = (cause: Error, causeParts: string[]): void => {
    Sentry.captureException(new Error('Attachment image metadata strip failed', { cause }), {
      tags: {
        'error.subsystem': 'agent-attachments',
        'error.operation': 'strip-image-metadata',
      },
      extra: { inputExtension: extension },
      fingerprint: ['agent-attachments-strip-image-metadata', extension, ...causeParts],
    });
  };
  const failure = (causeParts: string[]): StripImageMetadataResult => {
    report(lastError, causeParts);
    return { ok: false };
  };
  try {
    // The bounded decode is released however this attempt ends, including a
    // failed save: the ref holds the decoded pixels, and nothing else does.
    let live: ImageManipulator.ImageRef | undefined = undefined;
    try {
      live = await renderBounded(uri);
      const saved = await live.saveAsync({ compress: 1, format: saveFormatFor(extension) });
      return { ok: true, uri: saved.uri, extension: strippedExtension(extension) };
    } finally {
      live?.release();
    }
  } catch (firstError) {
    lastError = firstError instanceof Error ? firstError : new Error(String(firstError));
    // JPEG-family inputs (jpg, jpeg, gif, heic, heif) already encode to JPEG,
    // so the retry would repeat the identical call and pay a second full
    // decode/encode for a deterministic failure. Only a PNG or WebP encode
    // has an untried fallback left.
    if (saveFormatFor(extension) !== ImageManipulator.SaveFormat.JPEG) {
      try {
        let live: ImageManipulator.ImageRef | undefined = undefined;
        try {
          live = await renderBounded(uri);
          const saved = await live.saveAsync({
            compress: 1,
            format: ImageManipulator.SaveFormat.JPEG,
          });
          return { ok: true, uri: saved.uri, extension: 'jpg' };
        } finally {
          live?.release();
        }
      } catch (retryError) {
        lastError = retryError instanceof Error ? retryError : new Error(String(retryError));
      }
    }
    return failure(encoderCause(lastError));
  }
}
