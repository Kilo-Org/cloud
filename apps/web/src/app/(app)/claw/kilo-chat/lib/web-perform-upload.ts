import type { PerformUpload } from '@kilocode/kilo-chat-hooks';

type XhrResult = { status: number; aborted: boolean };

export type XhrOutcome = { kind: 'ok' } | { kind: 'aborted' } | { kind: 'error'; message: string };

export function mapXhrResultToOutcome(result: XhrResult): XhrOutcome {
  if (result.aborted) return { kind: 'aborted' };
  if (result.status === 0) return { kind: 'error', message: 'Network error during upload' };
  if (result.status >= 200 && result.status < 300) return { kind: 'ok' };
  return { kind: 'error', message: `Upload failed (${result.status})` };
}

export const webPerformUpload: PerformUpload = (blob, putUrl, putHeaders, opts) =>
  new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let aborted = false;

    function onAbort() {
      aborted = true;
      try {
        xhr.abort();
      } catch {
        // ignore
      }
      reject(new DOMException('Aborted', 'AbortError'));
    }

    if (opts.signal.aborted) {
      onAbort();
      return;
    }
    opts.signal.addEventListener('abort', onAbort, { once: true });

    xhr.open('PUT', putUrl, true);
    for (const [k, v] of Object.entries(putHeaders)) {
      if (k.toLowerCase() === 'content-length') continue;
      xhr.setRequestHeader(k, v);
    }

    xhr.upload.addEventListener('progress', e => {
      if (!e.lengthComputable || e.total === 0) return;
      opts.onProgress(e.loaded / e.total);
    });

    xhr.addEventListener('loadend', () => {
      opts.signal.removeEventListener('abort', onAbort);
      const outcome = mapXhrResultToOutcome({ status: xhr.status, aborted });
      if (outcome.kind === 'ok') resolve();
      else if (outcome.kind === 'aborted') reject(new DOMException('Aborted', 'AbortError'));
      else reject(new Error(outcome.message));
    });

    xhr.send(blob);
  });
