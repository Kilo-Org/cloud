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

export type AttachmentQueueState = { rows: QueuedAttachment[] };

export type AttachmentQueueAction =
  | { type: 'add'; row: QueuedAttachment }
  | { type: 'setInited'; tempId: string; attachmentId: string }
  | { type: 'setProgress'; tempId: string; progress: number }
  | { type: 'setReady'; tempId: string }
  | { type: 'setFailed'; tempId: string; error: string }
  | { type: 'retry'; tempId: string }
  | { type: 'remove'; tempId: string }
  | { type: 'clear' };

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
  addFile: (input: AddFileInput) => void;
  removeFile: (tempId: string) => void;
  retryFile: (tempId: string) => void;
  clear: () => void;
  readyBlocks: AttachmentBlock[];
  isUploading: boolean;
  hasFailed: boolean;
};

function defaultTempId(): string {
  return `tmp-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

export function useAttachmentQueue(
  client: KiloChatClient,
  conversationId: string | null,
  options: UseAttachmentQueueOptions
): UseAttachmentQueueResult {
  const [state, dispatch] = useReducer(attachmentQueueReducer, { rows: [] });
  const { performUpload, maxBytes, generateTempId, onSizeRejected } = options;
  const generate = generateTempId ?? defaultTempId;

  type Pending = {
    blob: Blob;
    abort: AbortController;
    putUrl?: string;
    putHeaders?: Record<string, string>;
    putUrlExpiresAtMs?: number;
  };
  const pendingRef = useRef<Map<string, Pending>>(new Map());

  type UploadArgs = { tempId: string; filename: string; mimeType: string; size: number };

  const startUpload = useCallback(
    async (args: UploadArgs) => {
      const { tempId, filename, mimeType, size } = args;
      const pending = pendingRef.current.get(tempId);
      if (!pending) return;
      if (!conversationId) {
        dispatch({ type: 'setFailed', tempId, error: 'No active conversation' });
        return;
      }

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

        await performUpload(pending.blob, putUrl, putHeaders, {
          signal: pending.abort.signal,
          onProgress: fraction => dispatch({ type: 'setProgress', tempId, progress: fraction }),
        });
        if (pending.abort.signal.aborted) return;
        dispatch({ type: 'setReady', tempId });
        // Release the blob once the upload has succeeded — the server-side
        // copy is now authoritative and the row no longer needs the bytes.
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
    (input: AddFileInput) => {
      if (input.blob.size > maxBytes) {
        onSizeRejected?.(input);
        return;
      }
      if (!conversationId) return;
      const tempId = generate();
      const size = input.blob.size;
      pendingRef.current.set(tempId, { blob: input.blob, abort: new AbortController() });
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
    },
    [conversationId, generate, maxBytes, onSizeRejected, startUpload]
  );

  const removeFile = useCallback((tempId: string) => {
    const pending = pendingRef.current.get(tempId);
    pending?.abort.abort();
    pendingRef.current.delete(tempId);
    dispatch({ type: 'remove', tempId });
  }, []);

  const retryFile = useCallback(
    (tempId: string) => {
      const existing = pendingRef.current.get(tempId);
      if (!existing) return;
      const row = state.rows.find(r => r.tempId === tempId);
      if (!row) return;
      existing.abort.abort();
      const fresh: Pending = {
        blob: existing.blob,
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
    dispatch({ type: 'clear' });
  }, []);

  useEffect(() => {
    return () => {
      for (const pending of pendingRef.current.values()) pending.abort.abort();
      pendingRef.current.clear();
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
    readyBlocks,
    isUploading,
    hasFailed,
  };
}
