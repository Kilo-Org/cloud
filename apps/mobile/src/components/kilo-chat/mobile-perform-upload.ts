import { type PerformUpload } from '@kilocode/kilo-chat-hooks';

type UploadResult = { status: number; aborted: boolean };

export type UploadOutcome =
  | { kind: 'ok' }
  | { kind: 'aborted' }
  | { kind: 'error'; message: string };

export function mapUploadResultToOutcome(result: UploadResult): UploadOutcome {
  if (result.aborted) {
    return { kind: 'aborted' };
  }

  if (result.status === 0) {
    return { kind: 'error', message: 'Network error during upload' };
  }

  if (result.status >= 200 && result.status < 300) {
    return { kind: 'ok' };
  }

  return { kind: 'error', message: `Upload failed (${result.status})` };
}

function createAbortError(): DOMException {
  return new DOMException('Aborted', 'AbortError');
}

export const mobilePerformUpload: PerformUpload = async (...args) => {
  const [blob, putUrl, putHeaders, opts] = args;

  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let aborted = false;

    function cleanup() {
      opts.signal.removeEventListener('abort', onAbort);
    }

    function onAbort() {
      aborted = true;
      try {
        xhr.abort();
      } catch {
        // Ignore abort errors from native XHR cleanup.
      }
      reject(createAbortError());
    }

    if (opts.signal.aborted) {
      onAbort();
      return;
    }

    opts.signal.addEventListener('abort', onAbort, { once: true });
    xhr.open('PUT', putUrl, true);

    for (const [key, value] of Object.entries(putHeaders)) {
      if (key.toLowerCase() !== 'content-length') {
        xhr.setRequestHeader(key, value);
      }
    }

    xhr.upload.addEventListener('progress', event => {
      if (!event.lengthComputable || event.total === 0) {
        return;
      }
      opts.onProgress(event.loaded / event.total);
    });

    xhr.addEventListener('loadend', () => {
      cleanup();
      const outcome = mapUploadResultToOutcome({ status: xhr.status, aborted });
      if (outcome.kind === 'ok') {
        resolve();
      } else if (outcome.kind === 'aborted') {
        reject(createAbortError());
      } else {
        reject(new Error(outcome.message));
      }
    });

    xhr.send(blob);
  });
};
