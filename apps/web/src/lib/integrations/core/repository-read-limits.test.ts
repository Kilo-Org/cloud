import { boundRepositoryResponse, withRepositoryReadDeadline } from './repository-read-limits';

const jsonHeaders = { 'content-type': 'application/json' };

afterEach(() => jest.useRealTimers());

describe('repository response bounds', () => {
  it('accepts exactly 1 MiB without changing the decoded data', async () => {
    const body = JSON.stringify('x'.repeat(1024 * 1024 - 2));
    const response = await boundRepositoryResponse(new Response(body, { headers: jsonHeaders }));
    expect(await response.json()).toHaveLength(1024 * 1024 - 2);
  });

  it.each(['stream', 'advertised', 'invalid length', 'content type', 'invalid bytes'])(
    'rejects and cancels %s before parsing',
    async failure => {
      let cancelled = false;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            failure === 'invalid bytes' ? new Uint8Array([255]) : new Uint8Array(1024 * 1024 + 1)
          );
          if (failure === 'invalid bytes') controller.close();
        },
        cancel() {
          cancelled = true;
        },
      });
      const headers = {
        ...jsonHeaders,
        ...(failure === 'advertised'
          ? { 'content-length': '1048577' }
          : failure === 'invalid length'
            ? { 'content-length': 'invalid' }
            : {}),
      };
      if (failure === 'content type') headers['content-type'] = 'text/html';
      await expect(boundRepositoryResponse(new Response(stream, { headers }))).rejects.toThrow();
      if (failure !== 'invalid bytes') expect(cancelled).toBe(true);
    }
  );

  it('cancels a stalled body at the operation deadline', async () => {
    jest.useFakeTimers();
    let cancelled = false;
    const response = new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
      { headers: jsonHeaders }
    );
    const result = withRepositoryReadDeadline({ bounded: true }, signal =>
      boundRepositoryResponse(response, signal)
    );
    const rejection = expect(result).rejects.toThrow('Repository fetch timed out');
    await jest.advanceTimersByTimeAsync(30_000);
    await rejection;
    expect(cancelled).toBe(true);
  });

  it('propagates caller cancellation without waiting for the deadline', async () => {
    const controller = new AbortController();
    const result = withRepositoryReadDeadline(
      { bounded: true, signal: controller.signal },
      async signal => {
        await new Promise<void>(resolve =>
          signal?.addEventListener('abort', () => resolve(), { once: true })
        );
        signal?.throwIfAborted();
      }
    );
    controller.abort(new Error('Read cancelled'));
    await expect(result).rejects.toThrow('Read cancelled');
  });
});
