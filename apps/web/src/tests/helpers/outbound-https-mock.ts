import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { request as httpsRequest } from 'node:https';

export type RecordedRequestHandle = EventEmitter & {
  end: (chunk?: Buffer) => void;
  destroy: jest.Mock;
  setTimeout: jest.Mock;
};

export type RecordedRequest = {
  options: {
    hostname: string;
    port: number;
    path: string;
    method: string;
    headers: Record<string, string>;
    family: number;
    servername?: string;
    lookup: (
      hostname: string,
      options: unknown,
      callback: (error: null, address: string, family: number) => void
    ) => void;
  };
  body: Buffer | null;
  request: RecordedRequestHandle;
};

export type HttpsReply = {
  status?: number;
  headers?: Record<string, string | string[]>;
  body?: string | Buffer;
  defer?: boolean;
};

/**
 * Records `node:https.request` calls made through the outbound transport. The
 * caller must `jest.mock('node:https', () => ({ request: jest.fn() }))`.
 */
export function recordHttpsRequests(
  reply: (request: RecordedRequest) => HttpsReply
): RecordedRequest[] {
  const recorded: RecordedRequest[] = [];
  jest.mocked(httpsRequest).mockImplementation(((options: unknown, onResponse: unknown) => {
    const request = new EventEmitter() as RecordedRequestHandle;
    const recordedRequest: RecordedRequest = {
      options: options as RecordedRequest['options'],
      body: null,
      request,
    };
    recorded.push(recordedRequest);
    request.end = (chunk?: Buffer) => {
      recordedRequest.body = chunk ?? null;
      queueMicrotask(() => {
        const result = reply(recordedRequest);
        if (result.defer) return;
        const response = Readable.from([Buffer.from(result.body ?? '')]) as Readable & {
          statusCode: number;
          statusText: string;
          headers: Record<string, string | string[]>;
        };
        response.statusCode = result.status ?? 200;
        response.statusText = '';
        response.headers = result.headers ?? {};
        (onResponse as (response: unknown) => void)(response);
      });
    };
    request.destroy = jest.fn((error?: Error) => {
      if (error) queueMicrotask(() => request.emit('error', error));
    });
    request.setTimeout = jest.fn();
    return request;
  }) as never);
  return recorded;
}

export function connectedAddress(request: RecordedRequest): string {
  const callback = jest.fn();
  request.options.lookup('host.example', {}, callback);
  expect(callback).toHaveBeenCalledTimes(1);
  const [error, address] = callback.mock.calls[0] as [null, string, number];
  expect(error).toBeNull();
  return address;
}
