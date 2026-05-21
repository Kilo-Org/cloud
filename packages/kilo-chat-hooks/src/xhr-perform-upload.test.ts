import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createXhrPerformUpload } from './use-attachment-queue';

type XhrListener = () => void;

class FakeXMLHttpRequest {
  static nextStatus = 204;
  static completeOnSend = true;
  static instances: FakeXMLHttpRequest[] = [];

  readonly upload = {
    addEventListener: vi.fn(),
  };
  readonly open = vi.fn();
  readonly setRequestHeader = vi.fn();
  status = 0;
  aborted = false;

  private readonly listeners = new Map<string, XhrListener[]>();

  constructor() {
    FakeXMLHttpRequest.instances.push(this);
  }

  addEventListener(event: string, listener: XhrListener) {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
  }

  send() {
    if (!FakeXMLHttpRequest.completeOnSend) {
      return;
    }
    this.status = FakeXMLHttpRequest.nextStatus;
    this.emit('loadend');
  }

  abort() {
    this.aborted = true;
  }

  private emit(event: string) {
    for (const listener of this.listeners.get(event) ?? []) {
      listener();
    }
  }
}

async function uploadWithStatus(status: number) {
  FakeXMLHttpRequest.nextStatus = status;
  const performUpload = createXhrPerformUpload();
  await performUpload(new Blob(['hello']), 'https://upload.example.test', {}, uploadOptions());
}

function uploadOptions() {
  return {
    onProgress: vi.fn(),
    signal: new AbortController().signal,
  };
}

describe('createXhrPerformUpload', () => {
  beforeEach(() => {
    vi.stubGlobal('XMLHttpRequest', FakeXMLHttpRequest);
    FakeXMLHttpRequest.nextStatus = 204;
    FakeXMLHttpRequest.completeOnSend = true;
    FakeXMLHttpRequest.instances = [];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves successful 2xx uploads', async () => {
    await uploadWithStatus(200);
    await uploadWithStatus(204);
  });

  it('maps network and HTTP errors', async () => {
    await expect(uploadWithStatus(0)).rejects.toThrow('Network error during upload');
    await expect(uploadWithStatus(403)).rejects.toThrow('Upload failed (403)');
    await expect(uploadWithStatus(500)).rejects.toThrow('Upload failed (500)');
  });

  it('rejects aborted uploads with an AbortError', async () => {
    FakeXMLHttpRequest.completeOnSend = false;
    const abort = new AbortController();
    const performUpload = createXhrPerformUpload();
    const upload = performUpload(
      new Blob(['hello']),
      'https://upload.example.test',
      {},
      {
        onProgress: vi.fn(),
        signal: abort.signal,
      }
    );

    abort.abort();

    await expect(upload).rejects.toMatchObject({ name: 'AbortError' });
    expect(FakeXMLHttpRequest.instances[0]?.aborted).toBe(true);
  });
});
