jest.mock('@/lib/config.server', () => ({
  INTERNAL_API_SECRET: 'internal-test-secret',
  KILOCLAW_API_URL: 'https://claw.test',
}));

import { KiloClawInternalClient } from '@/lib/kiloclaw/kiloclaw-internal-client';
import { classifyKiloclawMarkError } from '@/lib/user/deletion-queue/handlers/kiloclaw';

const HMAC = 'resource-hmac';

describe('classifyKiloclawMarkError', () => {
  it('treats an ownership/active-set mismatch as needs_attention', () => {
    expect(
      classifyKiloclawMarkError(
        new Error('GDPR instance batch did not match the exact active user-owned ID set'),
        HMAC
      )
    ).toEqual({
      kind: 'needs_attention',
      errorCode: 'ownership_mismatch',
      resourceHmac: HMAC,
    });
  });

  it('retries generic mark-destroyed failures', () => {
    expect(classifyKiloclawMarkError(new Error('Connection reset'), HMAC)).toEqual({
      kind: 'retry',
      errorCode: 'kiloclaw_mark_failed',
      httpStatusClass: 'error',
    });
  });
});

describe('KiloClawInternalClient.destroy', () => {
  it('passes the supplied signal to Fetch', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    const signal = new AbortController().signal;
    const client = new KiloClawInternalClient();

    await client.destroy('user-1', 'instance-1', { reason: 'admin_request', signal });

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://claw.test/api/platform/destroy?instanceId=instance-1',
      expect.objectContaining({ method: 'POST', signal })
    );
    fetchSpy.mockRestore();
  });
});
