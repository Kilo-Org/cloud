import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOG_UPLOAD_BODY_TIMEOUT_MS, readLogUploadBody } from './log-upload-policy.js';

afterEach(() => vi.useRealTimers());

function request(body: ReadableStream<Uint8Array>): Request {
  return new Request('https://logs.example/upload', {
    method: 'PUT',
    body,
    duplex: 'half',
  } as RequestInit);
}

describe('bounded log body', () => {
  it('retains all bytes at the exact limit', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3]));
        controller.close();
      },
    });
    expect(await readLogUploadBody(request(body), 3)).toEqual(new Uint8Array([1, 2, 3]));
  });
  it('rejects overflow without waiting for a guest cancellation promise', async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3, 4]));
      },
      cancel,
    });
    await expect(readLogUploadBody(request(body), 3)).rejects.toMatchObject({ status: 413 });
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('times out a sender that never sends EOF', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const body = new ReadableStream<Uint8Array>({ cancel });
    const pending = readLogUploadBody(request(body), 3);
    const assertion = expect(pending).rejects.toMatchObject({ status: 408 });
    await vi.advanceTimersByTimeAsync(LOG_UPLOAD_BODY_TIMEOUT_MS);
    await assertion;
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('does not extend the total deadline when bytes keep arriving', async () => {
    vi.useFakeTimers();
    let send: ((value: Uint8Array) => void) | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        send = value => controller.enqueue(value);
      },
    });
    const pending = readLogUploadBody(request(body), 100);
    const assertion = expect(pending).rejects.toMatchObject({ status: 408 });
    for (let n = 0; n < 3; n++) {
      send?.(new Uint8Array([1]));
      await vi.advanceTimersByTimeAsync(LOG_UPLOAD_BODY_TIMEOUT_MS / 3);
    }
    await assertion;
  });
});
