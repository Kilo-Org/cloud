const CALLBACK_THREAD_MESSAGE_CHUNK_LIMIT = 39_000;
const CALLBACK_THREAD_MESSAGE_CHUNK_PREFIX_RESERVE = 100;
const CALLBACK_FAILURE_DETAIL_LIMIT = 500;

function splitTextForCallbackPosts(text: string, chunkLimit: number): string[] {
  const chunks: string[] = [];
  let start = 0;
  const chunkBodyLimit = Math.max(1, chunkLimit - CALLBACK_THREAD_MESSAGE_CHUNK_PREFIX_RESERVE);

  while (start < text.length) {
    const hardEnd = Math.min(start + chunkBodyLimit, text.length);
    if (hardEnd === text.length) {
      chunks.push(text.slice(start));
      break;
    }

    const minSoftEnd = start + Math.floor(chunkBodyLimit / 2);
    const softBreaks = ['\n\n', '\n', ' '];
    let splitAt = hardEnd;

    for (const softBreak of softBreaks) {
      const candidate = text.lastIndexOf(softBreak, hardEnd);
      if (candidate > minSoftEnd) {
        splitAt = candidate + softBreak.length;
        break;
      }
    }

    chunks.push(text.slice(start, splitAt));
    start = splitAt;
  }

  return chunks;
}

export function buildCallbackThreadPostChunks(markdown: string): string[] {
  if (markdown.length <= CALLBACK_THREAD_MESSAGE_CHUNK_LIMIT) {
    return [markdown || ' '];
  }

  const chunks = splitTextForCallbackPosts(markdown, CALLBACK_THREAD_MESSAGE_CHUNK_LIMIT);
  return chunks.map((chunk, index) => {
    const part = index + 1;
    return `Cloud Agent callback result (${part}/${chunks.length}):\n\n${chunk}`;
  });
}

export function getCallbackErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  const serialized = JSON.stringify(error);
  return serialized || String(error);
}

function isCreditRelatedErrorMessage(message: string): boolean {
  const lowerMessage = message.toLowerCase();
  return (
    lowerMessage.includes('402') ||
    lowerMessage.includes('payment') ||
    lowerMessage.includes('credit') ||
    lowerMessage.includes('balance') ||
    lowerMessage.includes('usage_limit_exceeded')
  );
}

export function formatCallbackContinuationFailureMessage(error: unknown): string {
  const errorMessage = getCallbackErrorMessage(error);

  if (isCreditRelatedErrorMessage(errorMessage)) {
    return 'Cloud Agent finished, but Kilo Bot could not continue because credits are required. Add credits to continue, then send a new message if more work is needed.';
  }

  const detail = errorMessage.slice(0, CALLBACK_FAILURE_DETAIL_LIMIT);
  return `Cloud Agent finished, but Kilo Bot could not continue after the callback: ${detail}`;
}
