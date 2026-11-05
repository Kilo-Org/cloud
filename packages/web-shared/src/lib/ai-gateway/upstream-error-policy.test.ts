import { describe, it, expect, beforeEach } from '@jest/globals';
import { captureProxyError } from '@kilocode/web-shared/lib/ai-gateway/llm-proxy-helpers';
import { applyUpstreamErrorPolicy } from '@kilocode/web-shared/lib/ai-gateway/upstream-error-policy';

jest.mock('@kilocode/web-shared/lib/ai-gateway/llm-proxy-helpers', () => ({
  ...jest.requireActual('@kilocode/web-shared/lib/ai-gateway/llm-proxy-helpers'),
  captureProxyError: jest.fn(async () => {}),
}));

const captureMock = jest.mocked(captureProxyError);

function upstream(status: number) {
  return new Response(JSON.stringify({ error: `upstream ${status}` }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function baseParams(response: Response) {
  return {
    response,
    providerId: 'openrouter',
    isUserByok: false,
    user: { id: 'user-1' },
    request: { model: 'a/b' },
    organizationId: 'org-1',
    model: 'a/b',
  };
}

describe('applyUpstreamErrorPolicy', () => {
  beforeEach(() => {
    captureMock.mockClear();
  });

  it('ignores successful responses', async () => {
    expect(await applyUpstreamErrorPolicy(baseParams(upstream(200)))).toBeUndefined();
    expect(captureMock).not.toHaveBeenCalled();
  });

  it('replaces a platform-funded 402 with 503 and reports it to Sentry once', async () => {
    const response = upstream(402);
    const replacement = await applyUpstreamErrorPolicy(baseParams(response));

    expect(replacement?.status).toBe(503);
    expect(captureMock).toHaveBeenCalledTimes(1);
    expect(captureMock).toHaveBeenCalledWith(
      expect.objectContaining({
        response,
        errorMessage: 'openrouter returned 402 Payment Required',
        trackInSentry: true,
      })
    );
    expect(await response.json()).toEqual({ error: 'upstream 402' });
  });

  it('preserves a connected customer’s billing refusal without reporting a Kilo payment outage', async () => {
    const response = new Response(
      JSON.stringify({
        type: 'error',
        error: {
          type: 'billing_error',
          details: { error_code: 'linked_organization_spend_limit_reached' },
        },
      }),
      { status: 402 }
    );
    const replacement = await applyUpstreamErrorPolicy({
      ...baseParams(response),
      providerId: 'claude-billing',
      isUserByok: false,
    });
    expect(replacement).toBeUndefined();
    expect(captureMock).toHaveBeenCalledWith(expect.objectContaining({ trackInSentry: false }));
    expect((await response.json()).error.details.error_code).toBe(
      'linked_organization_spend_limit_reached'
    );
  });

  it('passes a BYOK 402 through and reports it without Sentry', async () => {
    const response = upstream(402);
    const replacement = await applyUpstreamErrorPolicy({
      ...baseParams(response),
      isUserByok: true,
    });

    expect(replacement).toBeUndefined();
    expect(captureMock).toHaveBeenCalledTimes(1);
    expect(captureMock).toHaveBeenCalledWith(
      expect.objectContaining({
        errorMessage: 'openrouter returned error 402',
        trackInSentry: false,
      })
    );
    expect(await response.text()).toContain('upstream 402');
  });

  it.each(
    [400, 401, 403, 429, 500, 502, 503, 504].flatMap(status =>
      [false, true].map(isUserByok => ({ status, isUserByok }))
    )
  )(
    'logs upstream $status without Sentry and passes it through with BYOK=$isUserByok',
    async ({ status, isUserByok }) => {
      const response = upstream(status);
      expect(
        await applyUpstreamErrorPolicy({ ...baseParams(response), isUserByok })
      ).toBeUndefined();
      expect(captureMock).toHaveBeenCalledTimes(1);
      expect(captureMock).toHaveBeenCalledWith(
        expect.objectContaining({
          response,
          errorMessage: `openrouter returned error ${status}`,
          trackInSentry: false,
        })
      );
      expect(response.bodyUsed).toBe(false);
      expect(await response.json()).toEqual({ error: `upstream ${status}` });
    }
  );

  it('forwards chat error context and the original request', async () => {
    const formData = new FormData();
    formData.set('model', 'a/b');
    const response = upstream(500);
    await applyUpstreamErrorPolicy({
      ...baseParams(response),
      isUserByok: true,
      request: formData,
      model: 'upstream/model',
      gatewayModel: 'gateway/model',
      byokProviderIds: ['anthropic'],
    });

    expect(captureMock).toHaveBeenCalledWith({
      user: { id: 'user-1' },
      request: formData,
      response,
      organizationId: 'org-1',
      model: 'upstream/model',
      gatewayModel: 'gateway/model',
      byokProviderIds: ['anthropic'],
      errorMessage: 'openrouter returned error 500',
      trackInSentry: false,
    });
  });
});
