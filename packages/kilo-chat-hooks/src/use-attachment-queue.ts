import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import type { AttachmentBlock, KiloChatClient, KiloChatOperation } from '@kilocode/kilo-chat';

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
  opts: {
    onProgress: (fraction: number) => void;
    signal: AbortSignal;
    // Old web/package uploaders omit admission. Remove the fallback only after
    // all producers migrate in a breaking release; the mobile adapter requires it.
    operation?: KiloChatOperation;
  }
) => Promise<void>;

function mapXhrUploadResultToOutcome(result: XhrUploadResult): XhrUploadOutcome {
  if (result.aborted) return { kind: 'aborted' };
  if (result.status === 0) return { kind: 'error', message: 'Network error during upload' };
  if (result.status >= 200 && result.status < 300) return { kind: 'ok' };
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
        if (key.toLowerCase() !== 'content-length') xhr.setRequestHeader(key, value);
      }
      xhr.upload.addEventListener('progress', event => {
        if (!event.lengthComputable || event.total === 0) return;
        if (opts.operation?.canPublish() ?? true) opts.onProgress(event.loaded / event.total);
      });
      xhr.addEventListener('loadend', () => {
        cleanup();
        const outcome = mapXhrUploadResultToOutcome({ status: xhr.status, aborted });
        if (outcome.kind === 'ok') resolve();
        else if (outcome.kind === 'aborted') reject(createAbortError());
        else reject(new Error(outcome.message));
      });
      try {
        // This is the final boundary, after initialization and any adapter work.
        opts.operation?.assertDispatch();
        if (opts.signal.aborted) {
          onAbort();
          return;
        }
        xhr.send(blob);
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
}

export type AddFileInput = {
  blob: Blob;
  filename: string;
  mimeType: string;
  operation?: KiloChatOperation;
};

export type UseAttachmentQueueOptions = {
  performUpload: PerformUpload;
  maxBytes: number;
  generateTempId?: () => string;
  onSizeRejected?: (input: AddFileInput) => void;
  // The old web/package form captures through the client when absent. Remove
  // the fallback only after all producers migrate; mobile supplies this hook.
  captureOperation?: () => KiloChatOperation;
};

export type UseAttachmentQueueResult = {
  rows: QueuedAttachment[];
  addFile: (input: AddFileInput) => string | null;
  removeFile: (tempId: string) => void;
  retryFile: (tempId: string, operation?: KiloChatOperation) => void;
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
  const { performUpload, maxBytes, generateTempId, onSizeRejected, captureOperation } = options;
  const generate = generateTempId ?? defaultTempId;
  type Pending = {
    abort: AbortController;
    client: KiloChatClient;
    operation: KiloChatOperation;
    putUrl?: string;
    putHeaders?: Record<string, string>;
    putUrlExpiresAtMs?: number;
  };
  const pendingRef = useRef<Map<string, Pending>>(new Map());
  // Retain local bytes through errors and completion until explicit send/remove.
  const blobsRef = useRef<Map<string, Blob>>(new Map());
  const capture = useCallback(
    (supplied?: KiloChatOperation): KiloChatOperation => {
      try {
        return client.captureOperation(supplied ?? captureOperation?.());
      } catch (error) {
        return {
          assertDispatch: () => {
            throw error;
          },
          canPublish: () => client.canPublish(),
        };
      }
    },
    [client, captureOperation]
  );
  type UploadArgs = { tempId: string; filename: string; mimeType: string; size: number };
  const startUpload = useCallback(
    async ({ tempId, filename, mimeType, size }: UploadArgs) => {
      const pending = pendingRef.current.get(tempId);
      const blob = blobsRef.current.get(tempId);
      if (!pending || !blob) return;
      const { operation } = pending;
      try {
        operation.assertDispatch();
        let putUrl = pending.putUrl;
        let putHeaders = pending.putHeaders;
        const expiresAtMs = pending.putUrlExpiresAtMs ?? 0;
        // Expire a minute early to avoid racing R2 at the boundary.
        if (!putUrl || !putHeaders || Date.now() > expiresAtMs - 60 * 1000) {
          const res = await pending.client.initAttachment(
            {
              conversationId,
              mimeType,
              size,
              filename,
              idempotencyKey: tempId,
            },
            operation
          );
          if (pending.abort.signal.aborted || !operation.canPublish()) return;
          pending.putUrl = res.putUrl;
          pending.putHeaders = res.putHeaders;
          pending.putUrlExpiresAtMs = res.putUrlExpiresAt * 1000;
          putUrl = res.putUrl;
          putHeaders = res.putHeaders;
          dispatch({ type: 'setInited', tempId, attachmentId: res.attachmentId });
        }
        operation.assertDispatch();
        await performUpload(blob, putUrl, putHeaders, {
          operation,
          signal: pending.abort.signal,
          onProgress: fraction => {
            if (operation.canPublish())
              dispatch({ type: 'setProgress', tempId, progress: fraction });
          },
        });
        if (pending.abort.signal.aborted || !operation.canPublish()) return;
        dispatch({ type: 'setReady', tempId });
        pendingRef.current.delete(tempId);
      } catch (err) {
        if (pending.abort.signal.aborted || !operation.canPublish()) return;
        dispatch({
          type: 'setFailed',
          tempId,
          error: err instanceof Error ? err.message : 'Upload failed',
        });
      }
    },
    [conversationId, performUpload]
  );

  const addFile = useCallback(
    (input: AddFileInput): string | null => {
      if (!client.canPublish() || (input.operation && !input.operation.canPublish())) return null;
      if (input.blob.size > maxBytes) {
        onSizeRejected?.(input);
        return null;
      }
      const operation = capture(input.operation);
      const tempId = generate();
      const size = input.blob.size;
      blobsRef.current.set(tempId, input.blob);
      pendingRef.current.set(tempId, { abort: new AbortController(), client, operation });
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
    [capture, client, generate, maxBytes, onSizeRejected, startUpload]
  );

  const removeFile = useCallback((tempId: string) => {
    pendingRef.current.get(tempId)?.abort.abort();
    pendingRef.current.delete(tempId);
    blobsRef.current.delete(tempId);
    dispatch({ type: 'remove', tempId });
  }, []);

  const retryFile = useCallback(
    (tempId: string, supplied?: KiloChatOperation) => {
      const existing = pendingRef.current.get(tempId);
      if (!existing || existing.client !== client || !existing.operation.canPublish()) return;
      if (!blobsRef.current.has(tempId)) return;
      const row = state.rows.find(r => r.tempId === tempId);
      if (!row) return;
      // An explicit retry is a new action. Capture at this call, never after a wait.
      const operation = capture(supplied);
      existing.abort.abort();
      pendingRef.current.set(tempId, { ...existing, abort: new AbortController(), operation });
      dispatch({ type: 'retry', tempId });
      void startUpload({ tempId, filename: row.filename, mimeType: row.mimeType, size: row.size });
    },
    [capture, client, startUpload, state.rows]
  );

  const clear = useCallback(() => {
    for (const pending of pendingRef.current.values()) pending.abort.abort();
    pendingRef.current.clear();
    blobsRef.current.clear();
    dispatch({ type: 'clear' });
  }, []);
  const clearFiles = useCallback((tempIds: string[]) => {
    for (const tempId of tempIds) {
      pendingRef.current.get(tempId)?.abort.abort();
      pendingRef.current.delete(tempId);
      blobsRef.current.delete(tempId);
    }
    dispatch({ type: 'clearFiles', tempIds });
  }, []);
  const getBlob = useCallback((tempId: string) => blobsRef.current.get(tempId) ?? null, []);
  useEffect(
    () => () => {
      for (const pending of pendingRef.current.values()) pending.abort.abort();
      pendingRef.current.clear();
      blobsRef.current.clear();
    },
    []
  );
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
