/**
 * The Workers runtime learns that a client went away only when a write to that
 * client fails. `request.signal` does not fire while a returned body waits for
 * upstream data, so a proxied model stream that sends nothing (a held stream,
 * a slow first token) stays open upstream after its client closes, and the
 * provider keeps generating. While the upstream sends nothing, this body adds
 * an SSE comment line at an event boundary once per interval. SSE parsers
 * ignore comment lines. When the client is gone the write fails, the runtime
 * cancels this body, and the cancel closes the upstream response.
 */
export const EVENT_STREAM_IDLE_PING_INTERVAL_MS = 2_000;

const PING = new TextEncoder().encode(': ping\n\n');

/** True when the bytes sent so far end with a blank line, so no event is open. */
function endsAtEventBoundary(tail: readonly number[]): boolean {
  const end = String.fromCharCode(...tail);
  return end === '' || end.endsWith('\n\n') || end.endsWith('\r\r') || end.endsWith('\r\n\r\n');
}

export function withEventStreamIdlePing(
  // Untyped because Workers types `Response.body` as `ReadableStream<any>`; reads are typed below.
  body: ReadableStream,
  intervalMs = EVENT_STREAM_IDLE_PING_INTERVAL_MS
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let timer: ReturnType<typeof setInterval> | undefined;
  let tail: number[] = [];
  let sentSinceTick = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      timer = setInterval(() => {
        if (!sentSinceTick && endsAtEventBoundary(tail)) controller.enqueue(PING);
        sentSinceTick = false;
      }, intervalMs);
    },
    async pull(controller) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch (error) {
        clearInterval(timer);
        controller.error(error);
        return;
      }
      if (result.done) {
        clearInterval(timer);
        controller.close();
        return;
      }
      sentSinceTick = true;
      tail = [...tail, ...result.value.subarray(-4)].slice(-4);
      controller.enqueue(result.value);
    },
    cancel(reason) {
      clearInterval(timer);
      return reader.cancel(reason);
    },
  });
}
