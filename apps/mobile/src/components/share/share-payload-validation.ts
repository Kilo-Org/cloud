import {
  canAddAttachments,
  classifyAttachment,
  describeClassificationFailure,
} from '@/lib/agent-attachments/validate';
import { type SharePayload } from '@/lib/share-payload';

type ClassificationReason = 'empty' | 'denied' | 'too-large' | 'unreadable';

export type RejectedNote = {
  name: string;
  reason: ClassificationReason;
};

/** Minimal file shape accepted into the share payload after validation. */
export type AcceptedShareFile = {
  name: string;
  uri: string;
  mimeType?: string;
  size?: number;
  measuredSize: number;
  kind: 'image' | 'document';
};

export type SharePayloadValidation =
  | {
      kind: 'all-rejected';
      /** null when the share had no files and no usable text (contentless). */
      reason: ClassificationReason | null;
      message: string;
    }
  | {
      kind: 'ok';
      accepted: AcceptedShareFile[];
      rejectedNotes: RejectedNote[];
      truncated: boolean;
      /** True when the payload has usable text and/or at least one accepted file. */
      usable: boolean;
    };

const CONTENTLESS_MESSAGE = 'Nothing to share — no text or files were included.';

type MeasuredFileInput = {
  name: string;
  measuredSize: number;
  uri: string;
  mimeType?: string;
};

/**
 * Pure pre-flight over already-measured file sizes. Injectable so unit tests
 * need no filesystem. Reuses classifyAttachment / canAddAttachments /
 * describeClassificationFailure — no second limit or allow-list.
 */
export function validateMeasuredShareFiles(input: {
  text: string;
  files: readonly MeasuredFileInput[];
  failedCopies?: readonly string[];
}): SharePayloadValidation {
  const rejectedNotes: RejectedNote[] = [];
  const classifiedAccepted: AcceptedShareFile[] = [];

  for (const file of input.files) {
    const classified = classifyAttachment({ name: file.name, size: file.measuredSize });
    if (!classified.ok) {
      rejectedNotes.push({ name: file.name, reason: classified.reason });
    } else {
      const accepted: AcceptedShareFile = {
        name: file.name,
        uri: file.uri,
        measuredSize: classified.size,
        size: classified.size,
        kind: classified.kind,
      };
      if (file.mimeType !== undefined) {
        accepted.mimeType = file.mimeType;
      }
      classifiedAccepted.push(accepted);
    }
  }

  // Failed cache copies are not classified files; surface them after
  // classification notes and never count them toward usable/accepted.
  for (const name of input.failedCopies ?? []) {
    rejectedNotes.push({ name, reason: 'unreadable' });
  }

  const hasUsableText = input.text.trim() !== '';

  if (classifiedAccepted.length === 0 && !hasUsableText) {
    const firstRejection = rejectedNotes[0];
    if (firstRejection) {
      return {
        kind: 'all-rejected',
        reason: firstRejection.reason,
        message: describeClassificationFailure(firstRejection.reason),
      };
    }
    return {
      kind: 'all-rejected',
      reason: null,
      message: CONTENTLESS_MESSAGE,
    };
  }

  const limit = canAddAttachments(0, classifiedAccepted.length);
  const accepted = classifiedAccepted.slice(0, limit.acceptedCount);
  const truncated = Boolean(limit.truncated);

  return {
    kind: 'ok',
    accepted,
    rejectedNotes,
    truncated,
    usable: hasUsableText || accepted.length > 0,
  };
}

type MeasureFn = (uri: string) => Promise<number | null>;

/**
 * Measure every file's real bytes, then run the pure classifier. Extension-
 * reported sizes are unreliable on iOS. `measure` defaults to the real
 * filesystem helper; inject in tests.
 */
export async function validateSharePayload(
  payload: SharePayload,
  measure?: MeasureFn
): Promise<SharePayloadValidation> {
  const measureSize = measure ?? (await loadDefaultMeasure());
  const measured = await Promise.all(
    payload.files.map(async candidate => {
      const measuredSize = (await measureSize(candidate.uri)) ?? candidate.size ?? 0;
      const input: MeasuredFileInput = {
        name: candidate.name,
        measuredSize,
        uri: candidate.uri,
      };
      if (candidate.mimeType !== undefined) {
        input.mimeType = candidate.mimeType;
      }
      return input;
    })
  );

  return validateMeasuredShareFiles({
    text: payload.text,
    files: measured,
    failedCopies: payload.failedFiles,
  });
}

async function loadDefaultMeasure(): Promise<MeasureFn> {
  const { measureLocalSize } = await import('@/lib/agent-attachments/upload-task');
  return measureLocalSize;
}
