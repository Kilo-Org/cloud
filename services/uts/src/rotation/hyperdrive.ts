import { z } from 'zod';
import type { DirectTarget } from './postgres';

const FETCH_TIMEOUT_MS = 10_000;

/**
 * https://developers.cloudflare.com/api/resources/hyperdrive/subresources/configs/methods/get/:
 * the fields of a config's origin the job reads. The API never returns the password.
 */
const OriginSchema = z.object({
  scheme: z.enum(['postgres', 'postgresql']),
  host: z.string().min(1),
  port: z.number().int().positive(),
  database: z.string().min(1),
  user: z.string().min(1),
});

const ConfigResponseSchema = z.object({
  success: z.literal(true),
  result: z.object({ id: z.string(), origin: OriginSchema }),
});

export type HyperdriveOrigin = z.infer<typeof OriginSchema>;

export type HyperdriveFailure =
  /** A timeout, a transport failure, 429 or 5xx: the next run tries again. */
  | { status: 'unreachable'; detail: string }
  /** A refused token, a missing config or a malformed answer: a configuration error. */
  | { status: 'refused'; detail: string };

export type HyperdriveRead = { status: 'ok'; origin: HyperdriveOrigin } | HyperdriveFailure;

export type HyperdriveSwitch = { status: 'switched' } | HyperdriveFailure;

/** The origin's direct endpoint, which the `ALTER` connects to. */
export function directTarget(origin: HyperdriveOrigin): DirectTarget {
  return { host: origin.host, port: origin.port, database: origin.database };
}

/**
 * Reads and switches the identity-store Hyperdrive configs through the Cloudflare API, with a
 * token that holds Hyperdrive edit rights only (design 5.2). The token and the password stay in
 * this instance; failures keep the status only, because a body can echo the request.
 */
export class HyperdriveClient {
  constructor(
    private readonly options: { baseUrl: string; accountId: string; token: () => Promise<string> },
    // The arrow keeps the global receiver; workerd refuses `fetch` called as a method.
    private readonly fetcher: typeof fetch = (input, init) => fetch(input, init)
  ) {}

  async read(configId: string): Promise<HyperdriveRead> {
    const answer = await this.#call(configId, { method: 'GET' });
    return answer.status === 'answered' ? await this.#origin(answer.response) : answer;
  }

  /**
   * Points the config at `user` with `password`, keeping its host, port and database, then reads
   * it back and checks the user. Hyperdrive keeps its open pool and opens new connections with the
   * new login, so queries in flight do not fail.
   */
  async switchLogin(
    configId: string,
    current: HyperdriveOrigin,
    user: string,
    password: string
  ): Promise<HyperdriveSwitch> {
    // https://developers.cloudflare.com/api/resources/hyperdrive/subresources/configs/methods/edit/
    const patched = await this.#call(configId, {
      method: 'PATCH',
      body: JSON.stringify({
        origin: {
          scheme: current.scheme,
          host: current.host,
          port: current.port,
          database: current.database,
          user,
          password,
        },
      }),
    });
    if (patched.status !== 'answered') return patched;
    const after = await this.#origin(patched.response);
    if (after.status !== 'ok') return after;
    if (after.origin.user !== user) {
      return { status: 'unreachable', detail: 'config did not report the new login' };
    }
    return { status: 'switched' };
  }

  async #origin(response: Response): Promise<HyperdriveRead> {
    const parsed = ConfigResponseSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) return { status: 'refused', detail: 'config response did not match' };
    return { status: 'ok', origin: parsed.data.result.origin };
  }

  async #call(
    configId: string,
    init: RequestInit
  ): Promise<{ status: 'answered'; response: Response } | HyperdriveFailure> {
    let token: string;
    try {
      token = await this.options.token();
    } catch {
      return { status: 'refused', detail: 'switch token unavailable' };
    }
    const url = `${this.options.baseUrl}/client/v4/accounts/${this.options.accountId}/hyperdrive/configs/${encodeURIComponent(configId)}`;
    let response: Response;
    try {
      response = await this.fetcher(url, {
        ...init,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch {
      return { status: 'unreachable', detail: 'cloudflare request failed' };
    }
    if (response.ok) return { status: 'answered', response };
    await response.body?.cancel();
    const detail = `cloudflare ${init.method} answered ${response.status}`;
    return response.status === 429 || response.status >= 500
      ? { status: 'unreachable', detail }
      : { status: 'refused', detail };
  }
}
