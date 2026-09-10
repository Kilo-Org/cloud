import { File, UploadType } from 'expo-file-system';
import { z } from 'zod';

import { API_BASE_URL } from '@/lib/config';

/**
 * The single Kilo gateway entry point for voice transcription. Every call to
 * the gateway for a recording lives here so the request shape (multipart file
 * part, feature header, organization scope) is one place to review.
 *
 * The upload runs through expo-file-system's native task, not `fetch`: React
 * Native 0.86's fetch serializes multipart bodies itself and rejects
 * React Native's classic URI-based file part ("Unsupported FormDataPart
 * implementation"), while the native uploader streams the recording from disk
 * without loading it into JS memory.
 */

export const TRANSCRIPTION_REQUEST_TIMEOUT_MS = 30_000;

const GATEWAY_TRANSCRIPTIONS_PATH = '/api/gateway/audio/transcriptions';

/** Wire contract for the transcription response. Untrusted upstream at the entry boundary. */
const TranscriptionResponseSchema = z.object({ text: z.string() });

export type TranscribeRecordingInput = {
  recordingUri: string;
  model: { id: string; name: string };
  /** BCP-47 language hint; omitted from the request when empty. */
  language?: string | null;
  organizationId: string | null | undefined;
  authToken: string;
  /** Caller-owned abort (e.g. unmount); aborting discards the request. */
  signal?: AbortSignal;
};

/**
 * Result of one transcription attempt. A failure carries just enough to
 * classify it: the HTTP status when the gateway answered, whether our own
 * timeout fired, and whether the request never left the device.
 */
export type TranscribeRecordingResult =
  | { ok: true; text: string }
  | { ok: false; status?: number; isTimeout: boolean; isNetworkError: boolean };

export type TranscriptionClassification =
  | 'success'
  | 'no-speech'
  | 'unreachable'
  | 'timeout'
  | 'model-unavailable'
  | 'auth'
  | 'server'
  | 'invalid-response';

const MODEL_UNAVAILABLE_STATUSES = new Set([400, 404, 410, 422]);
const AUTH_STATUSES = new Set([401, 403]);

/**
 * Wire headers for the transcription upload. The organization header is
 * present only when the request is scoped to an organization.
 */
type TranscriptionUploadHeaders = {
  Authorization: string;
  'X-KILOCODE-FEATURE': string;
  'X-KiloCode-OrganizationId'?: string;
};

/** Upload form fields. The language field is present only when provided. */
type TranscriptionUploadParameters = {
  model: string;
  language?: string;
};

/**
 * Transcribe one recording through the Kilo gateway. The recording streams
 * from disk as the multipart file part; the caller owns the auth token and
 * passes it in; nothing here mints a token.
 */
export async function transcribeRecording({
  recordingUri,
  model,
  language,
  organizationId,
  authToken,
  signal,
}: TranscribeRecordingInput): Promise<TranscribeRecordingResult> {
  const headers: TranscriptionUploadHeaders = {
    Authorization: `Bearer ${authToken}`,
    'X-KILOCODE-FEATURE': 'mobile-voice-input',
  };
  if (organizationId && organizationId !== '') {
    headers['X-KiloCode-OrganizationId'] = organizationId;
  }

  const trimmedLanguage = language?.trim() ?? '';
  const parameters: TranscriptionUploadParameters = { model: model.id };
  if (trimmedLanguage !== '') {
    parameters.language = trimmedLanguage;
  }

  const recordingFile = new File(recordingUri);
  const task = recordingFile.createUploadTask(`${API_BASE_URL}${GATEWAY_TRANSCRIPTIONS_PATH}`, {
    uploadType: UploadType.MULTIPART,
    fieldName: 'file',
    mimeType: 'audio/mp4',
    parameters,
    headers,
    httpMethod: 'POST',
    // The task cancels the native request on caller abort and rejects with
    // an AbortError, which the catch below maps to the caller's outcome.
    signal,
  });

  // The timeout aborts through its own controller so the catch can tell our
  // timeout apart from a caller abort: a closure-assigned boolean stays
  // control-flow-narrowed to its initializer for the type checker.
  const timeoutAbort = new AbortController();
  const timeoutId = setTimeout(() => {
    timeoutAbort.abort();
    task.cancel();
  }, TRANSCRIPTION_REQUEST_TIMEOUT_MS);

  try {
    const response = await task.uploadAsync();

    if (response.status < 200 || response.status >= 300) {
      // A gateway refusal carries its status.
      return { ok: false, status: response.status, isTimeout: false, isNetworkError: false };
    }

    try {
      // A body that is not `{ text: string }` is an invalid response, not a
      // crash — the gateway is untrusted upstream.
      const parsed = TranscriptionResponseSchema.parse(JSON.parse(response.body) as unknown);
      return { ok: true, text: parsed.text.trim() };
    } catch {
      return { ok: false, status: response.status, isTimeout: false, isNetworkError: false };
    }
  } catch {
    if (timeoutAbort.signal.aborted) {
      // Our own timeout fired; the rejection is that cancellation surfacing.
      return { ok: false, isTimeout: true, isNetworkError: false };
    }
    if (signal?.aborted) {
      // The caller aborted (e.g. unmount). It knows it cancelled and owns
      // the outcome; the shape still maps to invalid-response if surfaced.
      return { ok: false, isTimeout: false, isNetworkError: false };
    }
    // A task rejection without a status: the upload never completed.
    return { ok: false, isTimeout: false, isNetworkError: true };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Map a transcription outcome onto one user-facing state. The caller (the
 * voice-input controller) turns each value into copy: success → insert the
 * text; no-speech → the empty state; unreachable/timeout/server → a retryable
 * error; model-unavailable/auth → a non-retryable error with its own guidance;
 * invalid-response → an unexpected gateway body.
 */
export function classifyTranscriptionFailure(
  input:
    | { ok: true; text: string }
    | { ok: false; status?: number; isTimeout: boolean; isNetworkError: boolean }
): TranscriptionClassification {
  if (input.ok) {
    return input.text.trim() === '' ? 'no-speech' : 'success';
  }
  if (input.isTimeout) {
    return 'timeout';
  }
  if (input.isNetworkError) {
    return 'unreachable';
  }
  const { status } = input;
  if (status !== undefined && MODEL_UNAVAILABLE_STATUSES.has(status)) {
    return 'model-unavailable';
  }
  if (status !== undefined && AUTH_STATUSES.has(status)) {
    return 'auth';
  }
  if (status !== undefined && status >= 400) {
    return 'server';
  }
  return 'invalid-response';
}
