/* eslint-disable require-await, @typescript-eslint/require-await -- the fake upload resolves immediately, so the mock implementations settle without await (same as gateway-voice-input-engine.test.tsx) */
import {
  classifyTranscriptionFailure,
  transcribeRecording,
  TRANSCRIPTION_REQUEST_TIMEOUT_MS,
} from './gateway-transcription-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/config', () => ({ API_BASE_URL: 'https://api.example.com' }));

const createUploadTaskMock = vi.fn();
vi.mock('expo-file-system/legacy', () => ({
  FileSystemUploadType: { BINARY_CONTENT: 0, MULTIPART: 1 },
  createUploadTask: (...args: unknown[]) => createUploadTaskMock(...args),
}));

/** The last createUploadTask call, captured for request-shape assertions. */
function lastTaskCall(): {
  url: string;
  fileUri: string;
  options: {
    uploadType: number;
    fieldName: string;
    mimeType: string;
    parameters: Record<string, string>;
    headers: Record<string, string>;
    httpMethod: string;
  };
} {
  const call = createUploadTaskMock.mock.calls.at(-1) as [
    string,
    string,
    {
      uploadType: number;
      fieldName: string;
      mimeType: string;
      parameters: Record<string, string>;
      headers: Record<string, string>;
      httpMethod: string;
    },
  ];
  return { url: call[0], fileUri: call[1], options: call[2] };
}

/** Replace the upload outcome for subsequent calls. */
function mockUpload(implementation: () => Promise<{ status: number; body: string } | null>): void {
  createUploadTaskMock.mockImplementation(() => ({
    uploadAsync: implementation,
    cancelAsync: vi.fn(),
  }));
}

const BASE_INPUT = {
  recordingUri: 'file:///recordings/rec.m4a',
  model: { id: 'whisper-large-v3', name: 'Whisper Large v3' },
  organizationId: 'org-1' as const,
  authToken: 'token-1',
};

beforeEach(() => {
  mockUpload(async () => ({ status: 200, body: JSON.stringify({ text: 'hello' }) }));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('transcribeRecording', () => {
  it('sends the multipart task with the model field, the m4a file part and the gateway headers', async () => {
    const result = await transcribeRecording(BASE_INPUT);

    expect(result).toEqual({ ok: true, text: 'hello' });
    expect(createUploadTaskMock).toHaveBeenCalledTimes(1);
    const { url, fileUri, options } = lastTaskCall();
    expect(url).toBe('https://api.example.com/api/gateway/audio/transcriptions');
    expect(fileUri).toBe('file:///recordings/rec.m4a');
    expect(options.httpMethod).toBe('POST');
    expect(options.uploadType).toBe(1);
    expect(options.fieldName).toBe('file');
    expect(options.mimeType).toBe('audio/mp4');
    expect(options.parameters.model).toBe('whisper-large-v3');
    expect(options.headers).toEqual({
      Authorization: 'Bearer token-1',
      'X-KILOCODE-FEATURE': 'mobile-voice-input',
      'X-KiloCode-OrganizationId': 'org-1',
    });
  });

  it('omits the organization header when no organization is set', async () => {
    await transcribeRecording({ ...BASE_INPUT, organizationId: null });

    expect(lastTaskCall().options.headers).toEqual({
      Authorization: 'Bearer token-1',
      'X-KILOCODE-FEATURE': 'mobile-voice-input',
    });
  });

  it('appends the language when non-empty and omits it when empty', async () => {
    await transcribeRecording({ ...BASE_INPUT, language: 'en-US' });
    expect(lastTaskCall().options.parameters.language).toBe('en-US');

    await transcribeRecording({ ...BASE_INPUT, language: '  ' });
    expect(lastTaskCall().options.parameters.language).toBeUndefined();
  });

  it('classifies our timeout cancel as a timeout', async () => {
    vi.useFakeTimers();
    // The upload stays pending until the timeout's own cancel rejects it;
    // the executor hands the rejector out before any await settles.
    let rejectUpload: (error: Error) => void = vi.fn<() => void>();
    mockUpload(
      async () =>
        new Promise((_resolve, reject) => {
          rejectUpload = reject;
        })
    );

    const pending = transcribeRecording(BASE_INPUT);
    await vi.advanceTimersByTimeAsync(TRANSCRIPTION_REQUEST_TIMEOUT_MS);
    rejectUpload(new Error('Task cancelled'));
    const result = await pending;

    expect(result).toEqual({ ok: false, isTimeout: true, isNetworkError: false });
    expect(classifyTranscriptionFailure(result)).toBe('timeout');
  });

  it('classifies a timeout cancel that resolves without a response as a timeout', async () => {
    vi.useFakeTimers();
    // iOS resolves the native upload promise with null on cancel
    // (NSURLErrorCancelled), so the timeout cancellation can surface as a
    // resolve without a response instead of a rejection.
    let resolveUpload: (value: null) => void = vi.fn<() => void>();
    mockUpload(
      async () =>
        new Promise(resolve => {
          resolveUpload = resolve;
        })
    );

    const pending = transcribeRecording(BASE_INPUT);
    await vi.advanceTimersByTimeAsync(TRANSCRIPTION_REQUEST_TIMEOUT_MS);
    resolveUpload(null);
    const result = await pending;

    expect(result).toEqual({ ok: false, isTimeout: true, isNetworkError: false });
    expect(classifyTranscriptionFailure(result)).toBe('timeout');
  });

  it('classifies a task rejection as unreachable', async () => {
    mockUpload(async () => {
      throw new Error('Network request failed');
    });

    const result = await transcribeRecording(BASE_INPUT);

    expect(result).toEqual({ ok: false, isTimeout: false, isNetworkError: true });
    expect(classifyTranscriptionFailure(result)).toBe('unreachable');
  });

  it('classifies a 404 as model-unavailable', async () => {
    mockUpload(async () => ({ status: 404, body: '{}' }));

    const result = await transcribeRecording(BASE_INPUT);

    expect(result).toEqual({ ok: false, status: 404, isTimeout: false, isNetworkError: false });
    expect(classifyTranscriptionFailure(result)).toBe('model-unavailable');
  });

  it('classifies a 200 with an unparseable body as invalid-response', async () => {
    mockUpload(async () => ({ status: 200, body: JSON.stringify({ transcript: 'wrong shape' }) }));

    const result = await transcribeRecording(BASE_INPUT);

    expect(result).toEqual({ ok: false, status: 200, isTimeout: false, isNetworkError: false });
    expect(classifyTranscriptionFailure(result)).toBe('invalid-response');
  });

  it('classifies a 200 with empty text as no-speech', async () => {
    mockUpload(async () => ({ status: 200, body: JSON.stringify({ text: '   ' }) }));

    const result = await transcribeRecording(BASE_INPUT);

    expect(result).toEqual({ ok: true, text: '' });
    expect(classifyTranscriptionFailure(result)).toBe('no-speech');
  });

  it('trims the returned text on success', async () => {
    mockUpload(async () => ({ status: 200, body: JSON.stringify({ text: '  hello world  ' }) }));

    const result = await transcribeRecording(BASE_INPUT);

    expect(result).toEqual({ ok: true, text: 'hello world' });
    expect(classifyTranscriptionFailure(result)).toBe('success');
  });
});

describe('classifyTranscriptionFailure', () => {
  it('classifies success with text as success (happy state)', () => {
    expect(classifyTranscriptionFailure({ ok: true, text: 'hello' })).toBe('success');
  });

  it('classifies success with blank text as no-speech (empty state)', () => {
    expect(classifyTranscriptionFailure({ ok: true, text: '' })).toBe('no-speech');
  });

  it('classifies a network error as unreachable (retryable state)', () => {
    expect(
      classifyTranscriptionFailure({ ok: false, isTimeout: false, isNetworkError: true })
    ).toBe('unreachable');
  });

  it('classifies a timeout as timeout (retryable state)', () => {
    expect(
      classifyTranscriptionFailure({ ok: false, isTimeout: true, isNetworkError: false })
    ).toBe('timeout');
  });

  it('classifies other server statuses as server (retryable state)', () => {
    expect(
      classifyTranscriptionFailure({
        ok: false,
        status: 500,
        isTimeout: false,
        isNetworkError: false,
      })
    ).toBe('server');
    expect(
      classifyTranscriptionFailure({
        ok: false,
        status: 429,
        isTimeout: false,
        isNetworkError: false,
      })
    ).toBe('server');
  });

  it('classifies 400/404/410/422 as model-unavailable (non-retryable state)', () => {
    for (const status of [400, 404, 410, 422]) {
      expect(
        classifyTranscriptionFailure({
          ok: false,
          status,
          isTimeout: false,
          isNetworkError: false,
        })
      ).toBe('model-unavailable');
    }
  });

  it('classifies 401/403 as auth (non-retryable state)', () => {
    expect(
      classifyTranscriptionFailure({
        ok: false,
        status: 401,
        isTimeout: false,
        isNetworkError: false,
      })
    ).toBe('auth');
    expect(
      classifyTranscriptionFailure({
        ok: false,
        status: 403,
        isTimeout: false,
        isNetworkError: false,
      })
    ).toBe('auth');
  });

  it('classifies a failed outcome with no status and no flags as invalid-response', () => {
    expect(
      classifyTranscriptionFailure({ ok: false, isTimeout: false, isNetworkError: false })
    ).toBe('invalid-response');
  });
});
