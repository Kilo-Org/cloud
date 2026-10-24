/**
 * Minimal SSE consumer for the Workers-runtime suite. Parses `data:` frames out
 * of a `text/event-stream` response body one at a time.
 */
export type SseDataReader = {
  next(): Promise<unknown>;
  /** The next frame, or null when the stream ended. */
  nextOptional(): Promise<unknown | null>;
  cancel(): Promise<void>;
};

export function createSseDataReader(response: Response): SseDataReader {
  if (!response.body) {
    throw new Error('Expected an SSE response body');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let done = false;

  const readFrame = async (): Promise<unknown | null> => {
    for (;;) {
      const delimiter = buffer.indexOf('\n\n');
      if (delimiter >= 0) {
        const frame = buffer.slice(0, delimiter);
        buffer = buffer.slice(delimiter + 2);
        const data = frame
          .split('\n')
          .filter(line => line.startsWith('data:'))
          .map(line => line.slice('data:'.length).trimStart())
          .join('\n');
        if (data) return JSON.parse(data) as unknown;
        continue;
      }
      if (done) return null;
      const chunk = await reader.read();
      if (chunk.done) {
        done = true;
        return null;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  };

  return {
    async next(): Promise<unknown> {
      const frame = await readFrame();
      if (frame === null) throw new Error('Expected another SSE data frame');
      return frame;
    },
    nextOptional: readFrame,
    async cancel(): Promise<void> {
      await reader.cancel();
    },
  };
}

/**
 * Reads frames until `predicate` matches. Non-matching frames are returned
 * alongside the match so a test can assert on the full observed sequence.
 */
export async function readSseUntil(
  stream: SseDataReader,
  predicate: (frame: unknown) => boolean,
  maxFrames = 64
): Promise<{ match: unknown; observed: unknown[] }> {
  const observed: unknown[] = [];
  for (let index = 0; index < maxFrames; index += 1) {
    const frame = await stream.next();
    observed.push(frame);
    if (predicate(frame)) return { match: frame, observed };
  }
  throw new Error(`SSE frame predicate did not match within ${maxFrames} frames`);
}
