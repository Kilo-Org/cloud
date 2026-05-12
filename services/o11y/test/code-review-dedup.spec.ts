import { createExecutionContext, env as workerEnv } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import Worker from '../src/index';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
const TEST_CLIENT_SECRET = 'test-client-secret-value';

function makeTestEnv(): Env {
  return {
    O11Y_KILO_GATEWAY_CLIENT_SECRET: {
      get: async () => TEST_CLIENT_SECRET,
    } as SecretsStoreSecret,
    O11Y_ALERT_STATE: workerEnv.O11Y_ALERT_STATE,
  } as Env;
}

function makeRequest(
  alertKey: string,
  action: 'check' | 'record' = 'check',
  token = TEST_CLIENT_SECRET,
  severity: 'page' | 'ticket' = 'ticket'
): Request {
  return new IncomingRequest('https://example.com/alerting/code-review-dedup', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-O11Y-ADMIN-TOKEN': token,
    },
    body: JSON.stringify({ action, alertKey, severity }),
  });
}

async function workerFetch(request: Request, env: Env): Promise<Response> {
  const instance = new Worker(createExecutionContext(), env);
  return instance.fetch(request);
}

describe('code review dedup route', () => {
  it('requires the admin token', async () => {
    const response = await workerFetch(
      makeRequest(`auth-${crypto.randomUUID()}`, 'check', 'wrong'),
      makeTestEnv()
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: 'Unauthorized' });
  });

  it('checks and records alert suppression state', async () => {
    const env = makeTestEnv();
    const alertKey = `failure_rate-${crypto.randomUUID()}`;
    const kvKey = `o11y:alert:code_review:ticket:${alertKey}`;

    const initialCheckResponse = await workerFetch(makeRequest(alertKey), env);
    expect(initialCheckResponse.status).toBe(200);
    await expect(initialCheckResponse.json()).resolves.toEqual({ suppressed: false });
    await expect(workerEnv.O11Y_ALERT_STATE.get(kvKey)).resolves.toBeNull();

    const recordResponse = await workerFetch(makeRequest(alertKey, 'record'), env);
    expect(recordResponse.status).toBe(200);
    await expect(recordResponse.json()).resolves.toEqual({ success: true });
    await expect(workerEnv.O11Y_ALERT_STATE.get(kvKey)).resolves.toEqual(expect.any(String));

    const repeatedCheckResponse = await workerFetch(makeRequest(alertKey), env);
    expect(repeatedCheckResponse.status).toBe(200);
    await expect(repeatedCheckResponse.json()).resolves.toEqual({ suppressed: true });

    const differentResponse = await workerFetch(
      makeRequest(`stuck_reviews-${crypto.randomUUID()}`),
      env
    );
    expect(differentResponse.status).toBe(200);
    await expect(differentResponse.json()).resolves.toEqual({ suppressed: false });
  });

  it('suppresses ticket alerts when a page alert is already active', async () => {
    const env = makeTestEnv();
    const alertKey = `failure_rate-${crypto.randomUUID()}`;

    const recordPageResponse = await workerFetch(
      makeRequest(alertKey, 'record', TEST_CLIENT_SECRET, 'page'),
      env
    );
    expect(recordPageResponse.status).toBe(200);
    await expect(recordPageResponse.json()).resolves.toEqual({ success: true });

    const ticketCheckResponse = await workerFetch(makeRequest(alertKey), env);
    expect(ticketCheckResponse.status).toBe(200);
    await expect(ticketCheckResponse.json()).resolves.toEqual({ suppressed: true });

    const pageCheckResponse = await workerFetch(
      makeRequest(alertKey, 'check', TEST_CLIENT_SECRET, 'page'),
      env
    );
    expect(pageCheckResponse.status).toBe(200);
    await expect(pageCheckResponse.json()).resolves.toEqual({ suppressed: true });
  });

  it('does not let a ticket alert suppress a page alert for the same key', async () => {
    const env = makeTestEnv();
    const alertKey = `failure_rate-${crypto.randomUUID()}`;

    const recordTicketResponse = await workerFetch(makeRequest(alertKey, 'record'), env);
    expect(recordTicketResponse.status).toBe(200);
    await expect(recordTicketResponse.json()).resolves.toEqual({ success: true });

    const pageCheckResponse = await workerFetch(
      makeRequest(alertKey, 'check', TEST_CLIENT_SECRET, 'page'),
      env
    );
    expect(pageCheckResponse.status).toBe(200);
    await expect(pageCheckResponse.json()).resolves.toEqual({ suppressed: false });
  });
});
