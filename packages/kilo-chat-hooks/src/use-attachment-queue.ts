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
