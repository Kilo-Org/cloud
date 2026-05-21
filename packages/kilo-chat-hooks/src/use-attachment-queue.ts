import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import type { AttachmentBlock, KiloChatClient } from '@kilocode/kilo-chat';

export type QueuedAttachmentStatus = 'uploading' | 'ready' | 'failed';

export type QueuedAttachment = {
  tempId: string;
  filename: string;
  mimeType: string;
  size: number;
  status: QueuedAttachmentStatus;
  progress: number;
  attachmentId?: string;
  error?: string;
};

type XhrUploadResult = { status: number; aborted: boolean };

type XhrUploadOutcome = { kind: 'ok' } | { kind: 'aborted' } | { kind: 'error'; message: string };

export type AttachmentQueueState = { rows: QueuedAttachment[] };

export type AttachmentQueueAction =
  | { type: 'add'; row: QueuedAttachment }
  | { type: 'setInited'; tempId: string; attachmentId: string }
  | { type: 'setProgress'; tempId: string; progress: number }
  | { type: 'setReady'; tempId: string }
  | { type: 'setFailed'; tempId: string; error: string }
  | { type: 'retry'; tempId: string }
  | { type: 'remove'; tempId: string }
  | { type: 'clear' }
  | { type: 'clearFiles'; tempIds: string[] };

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function updateRow(
  rows: QueuedAttachment[],
  tempId: string,
  fn: (row: QueuedAttachment) => QueuedAttachment
): QueuedAttachment[] {
  return rows.map(r => (r.tempId === tempId ? fn(r) : r));
}

export function attachmentQueueReducer(
  state: AttachmentQueueState,
  action: AttachmentQueueAction
): AttachmentQueueState {
  switch (action.type) {
    case 'add':
      return { rows: [...state.rows, action.row] };
    case 'setInited':
      return {
        rows: updateRow(state.rows, action.tempId, r => ({
          ...r,
          attachmentId: action.attachmentId,
        })),
      };
    case 'setProgress':
      return {
        rows: updateRow(state.rows, action.tempId, r => ({
          ...r,
          progress: clamp01(action.progress),
        })),
      };
    case 'setReady':
      return {
        rows: updateRow(state.rows, action.tempId, r => ({
          ...r,
          status: 'ready',
          progress: 1,
        })),
      };
    case 'setFailed':
      return {
        rows: updateRow(state.rows, action.tempId, r => ({
          ...r,
          status: 'failed',
          error: action.error,
        })),
      };
    case 'retry':
      return {
        rows: updateRow(state.rows, action.tempId, r => ({
          ...r,
          status: 'uploading',
          progress: 0,
          error: undefined,
        })),
      };
    case 'remove':
      return { rows: state.rows.filter(r => r.tempId !== action.tempId) };
    case 'clear':
      return { rows: [] };
    case 'clearFiles': {
      const ids = new Set(action.tempIds);
      return { rows: state.rows.filter(r => !ids.has(r.tempId)) };
    }
  }
}

export function selectReadyBlocks(rows: QueuedAttachment[]): AttachmentBlock[] {
  return rows
    .filter(
      (r): r is QueuedAttachment & { attachmentId: string } =>
        r.status === 'ready' && typeof r.attachmentId === 'string'
    )
    .map(r => ({
      type: 'attachment' as const,
      attachmentId: r.attachmentId,
      mimeType: r.mimeType,
      size: r.size,
      filename: r.filename,
    }));
}

export function selectIsUploading(rows: QueuedAttachment[]): boolean {
  return rows.some(r => r.status === 'uploading');
}

export function selectHasFailed(rows: QueuedAttachment[]): boolean {
  return rows.some(r => r.status === 'failed');
}

export type PerformUpload = (
  blob: Blob,
  putUrl: string,
  putHeaders: Record<string, string>,
  opts: { onProgress: (fraction: number) => void; signal: AbortSignal }
) => Promise<void>;

function mapXhrUploadResultToOutcome(result: XhrUploadResult): XhrUploadOutcome {
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

export function createXhrPerformUpload(): PerformUpload {
  return (blob, putUrl, putHeaders, opts) =>
    new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      let aborted = false;

      function cleanup() {
        opts.signal.removeEventListener('abort', onAbort);
      }

      function createAbortError(): DOMException {
        return new DOMException('Aborted', 'AbortError');
      }

      function onAbort() {
        aborted = true;
        try {
          xhr.abort();
        } catch {
          // Ignore abort errors from native XHR cleanup.
        }
        cleanup();
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
        const outcome = mapXhrUploadResultToOutcome({ status: xhr.status, aborted });
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
}

export type AddFileInput = {
  blob: Blob;
  filename: string;
  mimeType: string;
};

export type UseAttachmentQueueOptions = {
  performUpload: PerformUpload;
  maxBytes: number;
  generateTempId?: () => string;
  onSizeRejected?: (input: AddFileInput) => void;
};

export type UseAttachmentQueueResult = {
  rows: QueuedAttachment[];
  addFile: (input: AddFileInput) => string | null;
  removeFile: (tempId: string) => void;
  retryFile: (tempId: string) => void;
  clear: () => void;
  clearFiles: (tempIds: string[]) => void;
  getBlob: (tempId: string) => Blob | null;
  readyBlocks: AttachmentBlock[];
  isUploading: boolean;
  hasFailed: boolean;
};

function defaultTempId(): string {
  return `tmp-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

export function useAttachmentQueue(
  client: KiloChatClient,
  conversationId: string,
  options: UseAttachmentQueueOptions
): UseAttachmentQueueResult {
  const [state, dispatch] = useReducer(attachmentQueueReducer, { rows: [] });
  const { performUpload, maxBytes, generateTempId, onSizeRejected } = options;
  const generate = generateTempId ?? defaultTempId;

  type Pending = {
    abort: AbortController;
    putUrl?: string;
    putHeaders?: Record<string, string>;
    putUrlExpiresAtMs?: number;
  };
  const pendingRef = useRef<Map<string, Pending>>(new Map());
  // Blobs are tracked separately so previews keep working after the upload
  // completes — pendingRef releases its entry on setReady to free upload
  // bookkeeping, but the local bytes are still useful for the preview chip
  // until the user sends or removes the attachment.
  const blobsRef = useRef<Map<string, Blob>>(new Map());

  type UploadArgs = { tempId: string; filename: string; mimeType: string; size: number };

  const startUpload = useCallback(
    async (args: UploadArgs) => {
      const { tempId, filename, mimeType, size } = args;
      const pending = pendingRef.current.get(tempId);
      const blob = blobsRef.current.get(tempId);
      if (!pending || !blob) return;

      try {
        let putUrl = pending.putUrl;
        let putHeaders = pending.putHeaders;
        const expiresAtMs = pending.putUrlExpiresAtMs ?? 0;
        // Treat the URL as expired a minute early to avoid racing R2 at the boundary.
        const putUrlExpired = Date.now() > expiresAtMs - 60 * 1000;

        if (!putUrl || !putHeaders || putUrlExpired) {
          const res = await client.initAttachment({
            conversationId,
            mimeType,
            size,
            filename,
            idempotencyKey: tempId,
          });
          if (pending.abort.signal.aborted) return;
          pending.putUrl = res.putUrl;
          pending.putHeaders = res.putHeaders;
          pending.putUrlExpiresAtMs = res.putUrlExpiresAt * 1000;
          putUrl = res.putUrl;
          putHeaders = res.putHeaders;
          dispatch({ type: 'setInited', tempId, attachmentId: res.attachmentId });
        }

        await performUpload(blob, putUrl, putHeaders, {
          signal: pending.abort.signal,
          onProgress: fraction => dispatch({ type: 'setProgress', tempId, progress: fraction }),
        });
        if (pending.abort.signal.aborted) return;
        dispatch({ type: 'setReady', tempId });
        // Release upload bookkeeping; blobsRef keeps the bytes alive for the
        // preview chip until send or remove.
        pendingRef.current.delete(tempId);
      } catch (err) {
        if (pending.abort.signal.aborted) return;
        const message = err instanceof Error ? err.message : 'Upload failed';
        dispatch({ type: 'setFailed', tempId, error: message });
      }
    },
    [client, conversationId, performUpload]
  );

  const addFile = useCallback(
    (input: AddFileInput): string | null => {
      if (input.blob.size > maxBytes) {
        onSizeRejected?.(input);
        return null;
      }
      const tempId = generate();
      const size = input.blob.size;
      blobsRef.current.set(tempId, input.blob);
      pendingRef.current.set(tempId, { abort: new AbortController() });
      dispatch({
        type: 'add',
        row: {
          tempId,
          filename: input.filename,
          mimeType: input.mimeType,
          size,
          status: 'uploading',
          progress: 0,
        },
      });
      void startUpload({ tempId, filename: input.filename, mimeType: input.mimeType, size });
      return tempId;
    },
    [conversationId, generate, maxBytes, onSizeRejected, startUpload]
  );

  const removeFile = useCallback((tempId: string) => {
    const pending = pendingRef.current.get(tempId);
    pending?.abort.abort();
    pendingRef.current.delete(tempId);
    blobsRef.current.delete(tempId);
    dispatch({ type: 'remove', tempId });
  }, []);

  const retryFile = useCallback(
    (tempId: string) => {
      const existing = pendingRef.current.get(tempId);
      if (!existing) return;
      if (!blobsRef.current.has(tempId)) return;
      const row = state.rows.find(r => r.tempId === tempId);
      if (!row) return;
      existing.abort.abort();
      const fresh: Pending = {
        abort: new AbortController(),
        putUrl: existing.putUrl,
        putHeaders: existing.putHeaders,
        putUrlExpiresAtMs: existing.putUrlExpiresAtMs,
      };
      pendingRef.current.set(tempId, fresh);
      dispatch({ type: 'retry', tempId });
      void startUpload({
        tempId,
        filename: row.filename,
        mimeType: row.mimeType,
        size: row.size,
      });
    },
    [startUpload, state.rows]
  );

  const clear = useCallback(() => {
    for (const pending of pendingRef.current.values()) pending.abort.abort();
    pendingRef.current.clear();
    blobsRef.current.clear();
    dispatch({ type: 'clear' });
  }, []);

  const clearFiles = useCallback((tempIds: string[]) => {
    for (const tempId of tempIds) {
      const pending = pendingRef.current.get(tempId);
      pending?.abort.abort();
      pendingRef.current.delete(tempId);
      blobsRef.current.delete(tempId);
    }
    dispatch({ type: 'clearFiles', tempIds });
  }, []);

  const getBlob = useCallback((tempId: string) => blobsRef.current.get(tempId) ?? null, []);

  useEffect(() => {
    return () => {
      for (const pending of pendingRef.current.values()) pending.abort.abort();
      pendingRef.current.clear();
      blobsRef.current.clear();
    };
  }, []);

  const readyBlocks = useMemo(() => selectReadyBlocks(state.rows), [state.rows]);
  const isUploading = useMemo(() => selectIsUploading(state.rows), [state.rows]);
  const hasFailed = useMemo(() => selectHasFailed(state.rows), [state.rows]);

  return {
    rows: state.rows,
    addFile,
    removeFile,
    retryFile,
    clear,
    clearFiles,
    getBlob,
    readyBlocks,
    isUploading,
    hasFailed,
  };
}
