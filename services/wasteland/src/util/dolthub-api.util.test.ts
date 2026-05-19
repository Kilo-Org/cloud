import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { upstreamExistsOnDolthub } from './dolthub-api.util';

/**
 * Tests for the two-stage upstream-existence probe used by
 * `storeCredential` to decide whether the upstream is reachable
 * before attempting follow-up writes.
 */
describe('upstreamExistsOnDolthub', () => {
  const originalFetch = globalThis.fetch;
  const fetchSpy = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchSpy.mockReset();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns true on a successful anonymous probe and never sends a token', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          query_execution_status: 'Success',
          repository_owner: 'hop',
          repository_name: 'wl-commons',
          commit_ref: 'main',
        }),
        { status: 200 }
      )
    );

    const result = await upstreamExistsOnDolthub('hop/wl-commons', 'oauth-token-1');
    expect(result).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const init = fetchSpy.mock.calls[0]?.[1];
    const headers = new Headers(init?.headers);
    // Anonymous: no authorization header on the first call.
    expect(headers.get('authorization')).toBeNull();
  });

  it('returns false without a token when the anonymous probe says missing', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          query_execution_status: 'Error',
          query_execution_message: 'no such repository',
        }),
        { status: 400 }
      )
    );

    const result = await upstreamExistsOnDolthub('totally/fake', null);
    expect(result).toBe(false);
    // Only one round-trip — no auth fallback when there's no token.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('falls back to authenticated /main probe when anonymous probe says missing', async () => {
    // Simulates a private repo: anonymous probe reports missing, but the
    // authenticated probe at /{owner}/{repo}/main resolves.
    fetchSpy
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            query_execution_status: 'Error',
            query_execution_message: 'no such repository',
          }),
          { status: 400 }
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ query_execution_status: 'Success', commit_ref: 'main' }), {
          status: 200,
        })
      );

    const result = await upstreamExistsOnDolthub('me/private', 'oauth-token-1');
    expect(result).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // Stage 2 must include the token AND the /main segment to satisfy
    // DoltHub's "calls authenticated with a token must include a refName"
    // rule. Verify both.
    const stage2Input = fetchSpy.mock.calls[1]?.[0];
    const stage2Url =
      typeof stage2Input === 'string'
        ? stage2Input
        : stage2Input instanceof URL
          ? stage2Input.toString()
          : (stage2Input?.url ?? '');
    expect(stage2Url).toContain('/me/private/main?');
    const stage2Headers = new Headers(fetchSpy.mock.calls[1]?.[1]?.headers);
    expect(stage2Headers.get('authorization')).toBe('token oauth-token-1');
  });

  it("treats 'branch not found' on the auth probe as exists=true", async () => {
    // Real repo with a non-`main` default branch — DoltHub returns 200
    // with status=Error and "branch not found" rather than 400.
    fetchSpy
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            query_execution_status: 'Error',
            query_execution_message: 'no such repository',
          }),
          { status: 400 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            query_execution_status: 'Error',
            query_execution_message: 'query error: branch not found',
          }),
          { status: 200 }
        )
      );

    const result = await upstreamExistsOnDolthub('me/master-default', 'tok');
    expect(result).toBe(true);
  });

  it('returns false when both stages report missing', async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          query_execution_status: 'Error',
          query_execution_message: 'no such repository',
        }),
        { status: 400 }
      )
    );

    const result = await upstreamExistsOnDolthub('me/genuinely-fake', 'tok');
    expect(result).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('returns false on transport failure of the anonymous probe', async () => {
    fetchSpy.mockRejectedValueOnce(new TypeError('network down'));

    // No token, so nothing to fall back to. Should resolve false rather
    // than throw — `storeCredential` and `selfInit` both treat false
    // as "skip the WL_UPSTREAM push" and shouldn't propagate transport
    // errors.
    const result = await upstreamExistsOnDolthub('hop/wl-commons', null);
    expect(result).toBe(false);
  });

  it('returns false on transport failure of the auth probe', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            query_execution_status: 'Error',
            query_execution_message: 'no such repository',
          }),
          { status: 400 }
        )
      )
      .mockRejectedValueOnce(new TypeError('network down'));

    const result = await upstreamExistsOnDolthub('me/private', 'tok');
    expect(result).toBe(false);
  });

  it('returns false when the response body is unparseable JSON', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('not json at all', { status: 200 }));

    const result = await upstreamExistsOnDolthub('hop/wl-commons', null);
    expect(result).toBe(false);
  });
});
