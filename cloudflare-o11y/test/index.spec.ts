import { createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect, vi } from 'vitest';
import worker from '../src/index';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const TEST_CLIENT_SECRET = 'test-client-secret-value';

function makeWriteDataPointSpy() {
	return { writeDataPoint: vi.fn() };
}

function makeKvMock(): KVNamespace {
	const store = new Map<string, string>();
	return {
		get: vi.fn(async (key: string) => store.get(key) ?? null),
		put: vi.fn(async (key: string, value: string) => {
			store.set(key, value);
		}),
		delete: vi.fn(async () => {}),
		list: vi.fn(async () => ({ keys: [], list_complete: true, cacheStatus: null })),
		getWithMetadata: vi.fn(async () => ({ value: null, metadata: null, cacheStatus: null })),
	} as unknown as KVNamespace;
}

function makeTestEnv(overrides?: Partial<Env>): Env {
	return {
		O11Y_KILO_GATEWAY_CLIENT_SECRET: {
			get: async () => TEST_CLIENT_SECRET,
		} as SecretsStoreSecret,
		POSTHOG_API_KEY: 'phc_GK2Pxl0HPj5ZPfwhLRjXrtdz8eD7e9MKnXiFrOqnB6z',
		POSTHOG_HOST: 'https://us.i.posthog.com',
		O11Y_API_METRICS: makeWriteDataPointSpy() as unknown as AnalyticsEngineDataset,
		O11Y_ALERT_STATE: makeKvMock(),
		O11Y_CF_ACCOUNT_ID: 'test-account-id' as never,
		O11Y_API_BASE_URL: 'https://api.kilo.ai',
		O11Y_CF_AE_API_TOKEN: { get: async () => 'test-ae-token' } as SecretsStoreSecret,
		O11Y_SLACK_WEBHOOK_PAGE: { get: async () => 'https://hooks.slack.com/test-page' } as SecretsStoreSecret,
		O11Y_SLACK_WEBHOOK_TICKET: { get: async () => 'https://hooks.slack.com/test-ticket' } as SecretsStoreSecret,
		...overrides,
	};
}

function makeValidApiMetricsBody(overrides?: Record<string, unknown>) {
	return {
		clientSecret: TEST_CLIENT_SECRET,
		kiloUserId: 'user_123',
		organizationId: 'org_456',
		isAnonymous: false,
		isStreaming: true,
		userByok: false,
		mode: 'build',
		provider: 'openai',
		requestedModel: 'kilo/auto',
		resolvedModel: 'anthropic/claude-sonnet-4.5',
		toolsAvailable: ['function:get_weather', 'function:searchDocs'],
		toolsUsed: ['function:searchDocs'],
		ttfbMs: 45,
		completeRequestMs: 123,
		statusCode: 200,
		tokens: {
			inputTokens: 10,
			outputTokens: 20,
			cacheWriteTokens: 0,
			cacheHitTokens: 3,
			totalTokens: 30,
		},
		...overrides,
	};
}

describe('o11y worker', () => {
	it('responds with Hello World! (unit style)', async () => {
		const request = new IncomingRequest('http://example.com');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, makeTestEnv(), ctx);
		await waitOnExecutionContext(ctx);
		expect(await response.text()).toMatchInlineSnapshot(`"Hello World!"`);
	});

	it('responds with Hello World! (integration style)', async () => {
		const response = await SELF.fetch('https://example.com');
		expect(await response.text()).toMatchInlineSnapshot(`"Hello World!"`);
	});

	it('accepts valid /ingest/api-metrics and returns 204', async () => {
		const env = makeTestEnv();
		const request = new IncomingRequest('https://example.com/ingest/api-metrics', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(makeValidApiMetricsBody({ statusCode: 429 })),
		});

		const response = await worker.fetch(request, env, createExecutionContext());
		expect(response.status).toBe(204);
	});

	it('writes data point to Analytics Engine on successful ingest', async () => {
		const aeSpy = makeWriteDataPointSpy();
		const env = makeTestEnv({ O11Y_API_METRICS: aeSpy as unknown as AnalyticsEngineDataset });

		const request = new IncomingRequest('https://example.com/ingest/api-metrics', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(makeValidApiMetricsBody({ statusCode: 200 })),
		});

		await worker.fetch(request, env, createExecutionContext());

		expect(aeSpy.writeDataPoint).toHaveBeenCalledOnce();
		const call = aeSpy.writeDataPoint.mock.calls[0][0];
		expect(call.indexes).toEqual(['openai:anthropic/claude-sonnet-4.5']);
		expect(call.blobs).toEqual(['openai', 'anthropic/claude-sonnet-4.5', 'kilo-gateway', '0']);
		expect(call.doubles).toEqual([45, 123, 200]);
	});

	it('marks errors correctly in AE data point (statusCode >= 400)', async () => {
		const aeSpy = makeWriteDataPointSpy();
		const env = makeTestEnv({ O11Y_API_METRICS: aeSpy as unknown as AnalyticsEngineDataset });

		const request = new IncomingRequest('https://example.com/ingest/api-metrics', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(makeValidApiMetricsBody({ statusCode: 500 })),
		});

		await worker.fetch(request, env, createExecutionContext());

		const call = aeSpy.writeDataPoint.mock.calls[0][0];
		expect(call.blobs[3]).toBe('1'); // isError
		expect(call.doubles[2]).toBe(500);
	});

	it('rejects unknown clientSecret', async () => {
		const request = new IncomingRequest('https://example.com/ingest/api-metrics', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(makeValidApiMetricsBody({ clientSecret: 'wrong-secret' })),
		});

		const response = await worker.fetch(request, makeTestEnv(), createExecutionContext());
		expect(response.status).toBe(403);
		const json = await response.json();
		expect(json).toMatchObject({ error: 'Unknown clientSecret' });
	});

	it('does not write to AE when clientSecret is invalid', async () => {
		const aeSpy = makeWriteDataPointSpy();
		const env = makeTestEnv({ O11Y_API_METRICS: aeSpy as unknown as AnalyticsEngineDataset });

		const request = new IncomingRequest('https://example.com/ingest/api-metrics', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(makeValidApiMetricsBody({ clientSecret: 'wrong-secret' })),
		});

		await worker.fetch(request, env, createExecutionContext());
		expect(aeSpy.writeDataPoint).not.toHaveBeenCalled();
	});

	it('rejects missing params in /ingest/api-metrics', async () => {
		const request = new IncomingRequest('https://example.com/ingest/api-metrics', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({}),
		});

		const response = await worker.fetch(request, makeTestEnv(), createExecutionContext());
		expect(response.status).toBe(400);
		const json = await response.json();
		expect(json).toMatchObject({ error: 'Invalid request body' });
	});
});
