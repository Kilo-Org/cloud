/**
 * Controls `performance.now()` so tests can time response bodies. Call `install`
 * in `beforeEach` and restore the returned spy after each test.
 */
export function createControlledClock() {
  let now = 0;
  return {
    install() {
      now = 0;
      return jest.spyOn(performance, 'now').mockImplementation(() => now);
    },
    /**
     * A body whose chunks arrive at the given `performance.now()` times. With a
     * high-water mark of 0 a chunk is only produced once the reader asks for it,
     * so the clock reads the chunk's time while the reader processes it. With
     * `failure`, the body errors after the last chunk instead of closing.
     */
    bodyArrivingAt(chunks: [at: number, text: string][], failure?: Error) {
      const encoder = new TextEncoder();
      const queue = [...chunks];
      return new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            const next = queue.shift();
            if (!next) {
              if (failure) controller.error(failure);
              else controller.close();
              return;
            }
            now = next[0];
            controller.enqueue(encoder.encode(next[1]));
          },
        },
        { highWaterMark: 0 }
      );
    },
  };
}
