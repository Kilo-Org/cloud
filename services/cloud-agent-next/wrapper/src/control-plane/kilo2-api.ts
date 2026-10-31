import { z } from 'zod';
import { fetchKiloServer, type KiloServer } from '../kilo-server-auth.js';

export {
  kilo2MessageSchema,
  kilo2SessionSchema,
  kilo2FormSchema,
  kilo2PermissionSchema,
  kilo2EventSchema,
} from '../../../src/shared/kilo2-conversation.js';
export type {
  Kilo2Message,
  Kilo2Session,
  Kilo2Event,
} from '../../../src/shared/kilo2-conversation.js';

export class Kilo2HttpError extends Error {
  constructor(
    readonly status: number,
    operation: string
  ) {
    super(`Kilo v2 ${operation} failed: HTTP ${status}`);
  }
}

export function createKilo2Api(server: KiloServer) {
  async function request(
    path: string,
    options: { method?: string; body?: unknown; signal?: AbortSignal } = {}
  ): Promise<unknown> {
    const response = await fetchKiloServer(server, path, {
      method: options.method ?? 'GET',
      signal: options.signal ?? AbortSignal.timeout(20_000),
      ...(options.body === undefined
        ? {}
        : {
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(options.body),
          }),
    });
    if (!response.ok) throw new Kilo2HttpError(response.status, path.split('?')[0]);
    if (response.status === 204) return undefined;
    return response.json();
  }
  async function data(path: string, options?: Parameters<typeof request>[1]) {
    return z.object({ data: z.unknown() }).parse(await request(path, options)).data;
  }
  return { request, data };
}

export type Kilo2Api = ReturnType<typeof createKilo2Api>;
export const kilo2SessionPath = (id: string) => `/api/session/${encodeURIComponent(id)}`;
