import type { CallbackJob } from './types.js';

// Queues allow 128,000 bytes including roughly 100 bytes of internal metadata.
export const CALLBACK_QUEUE_MAX_SERIALIZED_BYTES = 127_000;

export type CallbackJobQueueFitResult =
  | {
      status: 'ready';
      job: CallbackJob;
      serializedByteLength: number;
    }
  | {
      status: 'too-large';
      serializedByteLength: number;
      maximumByteLength: number;
    };

function jsonStringUtf8ByteLength(value: string): number {
  let byteLength = 2;

  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit === 0x22 || codeUnit === 0x5c || codeUnit === 0x08 || codeUnit === 0x09) {
      byteLength += 2;
    } else if (codeUnit === 0x0a || codeUnit === 0x0c || codeUnit === 0x0d) {
      byteLength += 2;
    } else if (codeUnit <= 0x1f) {
      byteLength += 6;
    } else if (codeUnit <= 0x7f) {
      byteLength += 1;
    } else if (codeUnit <= 0x7ff) {
      byteLength += 2;
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
        byteLength += 4;
        index += 1;
      } else {
        byteLength += 6;
      }
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      byteLength += 6;
    } else {
      byteLength += 3;
    }
  }

  return byteLength;
}

function serializedJsonByteLength(value: unknown, arrayEntry = false): number | undefined {
  if (value === null) return 4;

  switch (typeof value) {
    case 'string':
      return jsonStringUtf8ByteLength(value);
    case 'number':
      return Number.isFinite(value) ? String(value).length : 4;
    case 'boolean':
      return value ? 4 : 5;
    case 'undefined':
    case 'function':
    case 'symbol':
      return arrayEntry ? 4 : undefined;
    case 'bigint':
      throw new TypeError('Cannot serialize BigInt in callback job');
    case 'object': {
      if (Array.isArray(value)) {
        let byteLength = 2;
        for (let index = 0; index < value.length; index += 1) {
          if (index > 0) byteLength += 1;
          byteLength += serializedJsonByteLength(value[index], true) ?? 4;
        }
        return byteLength;
      }

      let byteLength = 2;
      let serializedEntries = 0;
      for (const [key, entryValue] of Object.entries(value)) {
        const entryByteLength = serializedJsonByteLength(entryValue);
        if (entryByteLength === undefined) continue;
        if (serializedEntries > 0) byteLength += 1;
        byteLength += jsonStringUtf8ByteLength(key) + 1 + entryByteLength;
        serializedEntries += 1;
      }
      return byteLength;
    }
  }
}

export function serializedCallbackJobByteLength(job: CallbackJob): number {
  const byteLength = serializedJsonByteLength(job);
  if (byteLength === undefined) {
    throw new TypeError('Callback job cannot be serialized as JSON');
  }
  return byteLength;
}

function utf8ByteLength(value: string): number {
  let byteLength = 0;

  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x7f) {
      byteLength += 1;
    } else if (codeUnit <= 0x7ff) {
      byteLength += 2;
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
        byteLength += 4;
        index += 1;
      } else {
        byteLength += 3;
      }
    } else {
      byteLength += 3;
    }
  }

  return byteLength;
}

function sliceAtUnicodeBoundary(value: string, end: number): string {
  let boundary = end;
  if (boundary > 0 && boundary < value.length) {
    const previousCodeUnit = value.charCodeAt(boundary - 1);
    if (previousCodeUnit >= 0xd800 && previousCodeUnit <= 0xdbff) {
      boundary -= 1;
    }
  }
  return value.slice(0, boundary);
}

type TruncateCallbackText = (
  job: CallbackJob,
  text: string,
  originalUtf8ByteLength: number
) => CallbackJob;

type CallbackTextFitResult =
  | {
      status: 'ready';
      job: CallbackJob;
      serializedByteLength: number;
    }
  | {
      status: 'too-large';
      minimizedJob: CallbackJob;
      serializedByteLength: number;
    };

function omittedAssistantTextJob(job: CallbackJob, originalUtf8ByteLength: number): CallbackJob {
  const payload = { ...job.payload };
  delete payload.lastAssistantMessageText;
  return {
    ...job,
    payload: {
      ...payload,
      lastAssistantMessageTextTruncation: {
        originalUtf8ByteLength,
        retainedUtf8ByteLength: 0,
      },
    },
  };
}

function truncatedErrorMessageJob(
  job: CallbackJob,
  text: string,
  originalUtf8ByteLength: number
): CallbackJob {
  return {
    ...job,
    payload: {
      ...job.payload,
      errorMessage: text,
      errorMessageTruncation: {
        originalUtf8ByteLength,
        retainedUtf8ByteLength: utf8ByteLength(text),
      },
    },
  };
}

function fitCallbackTextToQueueLimit(
  job: CallbackJob,
  text: string,
  truncate: TruncateCallbackText
): CallbackTextFitResult {
  const originalUtf8ByteLength = utf8ByteLength(text);
  const emptyTextJob = truncate(job, '', originalUtf8ByteLength);
  const emptyTextJobByteLength = serializedCallbackJobByteLength(emptyTextJob);
  if (emptyTextJobByteLength > CALLBACK_QUEUE_MAX_SERIALIZED_BYTES) {
    return {
      status: 'too-large',
      minimizedJob: emptyTextJob,
      serializedByteLength: emptyTextJobByteLength,
    };
  }

  let lowerBound = 0;
  let upperBound = Math.min(text.length, CALLBACK_QUEUE_MAX_SERIALIZED_BYTES);
  let fittedJob = emptyTextJob;
  let fittedByteLength = emptyTextJobByteLength;

  while (lowerBound <= upperBound) {
    const midpoint = Math.floor((lowerBound + upperBound) / 2);
    const candidateText = sliceAtUnicodeBoundary(text, midpoint);
    const candidateJob = truncate(job, candidateText, originalUtf8ByteLength);
    const candidateByteLength = serializedCallbackJobByteLength(candidateJob);

    if (candidateByteLength <= CALLBACK_QUEUE_MAX_SERIALIZED_BYTES) {
      fittedJob = candidateJob;
      fittedByteLength = candidateByteLength;
      lowerBound = midpoint + 1;
    } else {
      upperBound = midpoint - 1;
    }
  }

  return {
    status: 'ready',
    job: fittedJob,
    serializedByteLength: fittedByteLength,
  };
}

export function fitCallbackJobToQueueLimit(job: CallbackJob): CallbackJobQueueFitResult {
  let candidateJob = job;
  let serializedByteLength = serializedCallbackJobByteLength(candidateJob);
  if (serializedByteLength <= CALLBACK_QUEUE_MAX_SERIALIZED_BYTES) {
    return { status: 'ready', job: candidateJob, serializedByteLength };
  }

  const assistantText = candidateJob.payload.lastAssistantMessageText;
  if (assistantText !== undefined) {
    candidateJob = omittedAssistantTextJob(candidateJob, utf8ByteLength(assistantText));
    serializedByteLength = serializedCallbackJobByteLength(candidateJob);
    if (serializedByteLength <= CALLBACK_QUEUE_MAX_SERIALIZED_BYTES) {
      return { status: 'ready', job: candidateJob, serializedByteLength };
    }
  }

  const errorMessage = candidateJob.payload.errorMessage;
  if (errorMessage !== undefined) {
    const errorResult = fitCallbackTextToQueueLimit(
      candidateJob,
      errorMessage,
      truncatedErrorMessageJob
    );
    if (errorResult.status === 'ready') return errorResult;
    serializedByteLength = errorResult.serializedByteLength;
  }

  return {
    status: 'too-large',
    serializedByteLength,
    maximumByteLength: CALLBACK_QUEUE_MAX_SERIALIZED_BYTES,
  };
}
