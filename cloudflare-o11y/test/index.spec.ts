import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, vi } from 'vitest';
import Worker from '../src/index';

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

function makeAlertConfigDOMock(): Env['ALERT_CONFIG_DO'] {
	return {
		idFromName: vi.fn(() => 'mock-do-id' as unknown as DurableObjectId),
		get: vi.fn(() => ({
			list: vi.fn(async () => []),
			get: vi.fn(async () => null),
			upsert: vi.fn(async () => {}),
			remove: vi.fn(async () => {}),
		})),
	} as unknown as Env['ALERT_CONFIG_DO'];
}

function makeTestEnv(overrides?: Partial<Env>): Env {
	return {
		O11Y_KILO_GATEWAY_CLIENT_SECRET: {
			get: async () => TEST_CLIENT_SECRET,
		} as SecretsStoreSecret,
		O11Y_API_METRICS: makeWriteDataPointSpy() as unknown as AnalyticsEngineDataset,
		O11Y_SESSION_METRICS: makeWriteDataPointSpy() as unknown as AnalyticsEngineDataset,
		O11Y_ALERT_STATE: makeKvMock(),
		ALERT_CONFIG_DO: makeAlertConfigDOMock(),
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
		kiloUserId: 'user_123',
		organizationId: 'org_456',
		isAnonymous: false,
		isStreaming: true,
		userByok: false,
		mode: 'build',
		provider: 'openai',
		inferenceProvider: 'openai',
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

/** Helper to invoke the worker's fetch handler with a given env (unit-style). */
async function workerFetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const instance = new Worker(ctx, env);
	return instance.fetch(request);
}

describe('o11y worker', () => {
	it('accepts valid /ingest/api-metrics and returns 204', async () => {
		const env = makeTestEnv();
		const request = new IncomingRequest('https://example.com/ingest/api-metrics', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'X-O11Y-ADMIN-TOKEN': TEST_CLIENT_SECRET,
			},
			body: JSON.stringify(makeValidApiMetricsBody({ statusCode: 429 })),
		});

		const response = await workerFetch(request, env, createExecutionContext());
		expect(response.status).toBe(204);
	});

	it('writes data point to Analytics Engine on successful ingest', async () => {
		const aeSpy = makeWriteDataPointSpy();
		const env = makeTestEnv({ O11Y_API_METRICS: aeSpy as unknown as AnalyticsEngineDataset });

		const request = new IncomingRequest('https://example.com/ingest/api-metrics', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'X-O11Y-ADMIN-TOKEN': TEST_CLIENT_SECRET,
			},
			body: JSON.stringify(makeValidApiMetricsBody({ statusCode: 200 })),
		});

		await workerFetch(request, env, createExecutionContext());

		expect(aeSpy.writeDataPoint).toHaveBeenCalledOnce();
		const call = aeSpy.writeDataPoint.mock.calls[0][0];
		expect(call.indexes).toEqual(['anthropic/claude-sonnet-4.5']);
		expect(call.blobs).toEqual(['openai', 'anthropic/claude-sonnet-4.5', 'kilo-gateway', '0', 'openai']);
		expect(call.doubles).toEqual([45, 123, 200]);
	});

	it('defaults inferenceProvider to empty string', async () => {
		const aeSpy = makeWriteDataPointSpy();
		const env = makeTestEnv({ O11Y_API_METRICS: aeSpy as unknown as AnalyticsEngineDataset });
		const { inferenceProvider: _ignored, ...body } = makeValidApiMetricsBody();

		const request = new IncomingRequest('https://example.com/ingest/api-metrics', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'X-O11Y-ADMIN-TOKEN': TEST_CLIENT_SECRET,
			},
			body: JSON.stringify(body),
		});

		const response = await workerFetch(request, env, createExecutionContext());
		expect(response.status).toBe(204);

		expect(aeSpy.writeDataPoint).toHaveBeenCalledOnce();
		const call = aeSpy.writeDataPoint.mock.calls[0][0];
		expect(call.blobs[4]).toBe('');
	});

	it('marks errors correctly in AE data point (statusCode >= 400)', async () => {
		const aeSpy = makeWriteDataPointSpy();
		const env = makeTestEnv({ O11Y_API_METRICS: aeSpy as unknown as AnalyticsEngineDataset });

		const request = new IncomingRequest('https://example.com/ingest/api-metrics', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'X-O11Y-ADMIN-TOKEN': TEST_CLIENT_SECRET,
			},
			body: JSON.stringify(makeValidApiMetricsBody({ statusCode: 500 })),
		});

		await workerFetch(request, env, createExecutionContext());

		const call = aeSpy.writeDataPoint.mock.calls[0][0];
		expect(call.blobs[3]).toBe('1'); // isError
		expect(call.doubles[2]).toBe(500);
	});

	it('requires admin token for api-metrics ingest', async () => {
		const request = new IncomingRequest('https://example.com/ingest/api-metrics', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(makeValidApiMetricsBody()),
		});

		const response = await workerFetch(request, makeTestEnv(), createExecutionContext());
		expect(response.status).toBe(401);
	});

	it('rejects missing params in /ingest/api-metrics', async () => {
		const request = new IncomingRequest('https://example.com/ingest/api-metrics', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'X-O11Y-ADMIN-TOKEN': TEST_CLIENT_SECRET,
			},
			body: JSON.stringify({}),
		});

		const response = await workerFetch(request, makeTestEnv(), createExecutionContext());
		expect(response.status).toBe(400);
		const json = await response.json();
		expect(json).toMatchObject({ error: 'Invalid request body' });
	});
});

describe('session metrics RPC', () => {
	function makeValidSessionMetrics() {
		return {
			kiloUserId: 'user_123',
			organizationId: 'org_456',
			sessionId: 'ses_01234567890123456789012345',
			platform: 'cli',
			sessionDurationMs: 60000,
			timeToFirstResponseMs: 1500,
			totalTurns: 5,
			totalSteps: 12,
			toolCallsByType: { read_file: 3, write_file: 2 },
			toolErrorsByType: { write_file: 1 },
			totalErrors: 2,
			errorsByType: { APIError: 1, UnknownError: 1 },
			stuckToolCallCount: 0,
			totalTokens: {
				input: 10000,
				output: 5000,
				reasoning: 2000,
				cacheRead: 3000,
				cacheWrite: 1000,
			},
			totalCost: 0.15,
			compactionCount: 1,
			autoCompactionCount: 1,
			terminationReason: 'completed' as const,
			model: 'anthropic/claude-sonnet-4',
			ingestVersion: 1,
		};
	}

	it('writes session metrics to Analytics Engine', async () => {
		const aeSpy = makeWriteDataPointSpy();
		const env = makeTestEnv({ O11Y_SESSION_METRICS: aeSpy as unknown as AnalyticsEngineDataset });
		const ctx = createExecutionContext();
		const instance = new Worker(ctx, env);

		await instance.ingestSessionMetrics(makeValidSessionMetrics());
		await waitOnExecutionContext(ctx);

		expect(aeSpy.writeDataPoint).toHaveBeenCalledOnce();
		const call = aeSpy.writeDataPoint.mock.calls[0][0];
		expect(call.indexes).toEqual(['cli']);
		expect(call.blobs).toEqual(['completed', 'cli', 'org_456', 'user_123', 'anthropic/claude-sonnet-4']);
		expect(call.doubles).toEqual([60000, 1500, 5, 12, 2, 21000, 0.15, 1, 0, 1, 1]);
	});

	it('uses empty string for missing organizationId in AE', async () => {
		const aeSpy = makeWriteDataPointSpy();
		const env = makeTestEnv({ O11Y_SESSION_METRICS: aeSpy as unknown as AnalyticsEngineDataset });
		const ctx = createExecutionContext();
		const instance = new Worker(ctx, env);

		const params = makeValidSessionMetrics();
		delete (params as Record<string, unknown>).organizationId;
		await instance.ingestSessionMetrics(params);

		const call = aeSpy.writeDataPoint.mock.calls[0][0];
		expect(call.blobs[2]).toBe('');
	});

	it('uses -1 for missing timeToFirstResponseMs', async () => {
		const aeSpy = makeWriteDataPointSpy();
		const env = makeTestEnv({ O11Y_SESSION_METRICS: aeSpy as unknown as AnalyticsEngineDataset });
		const ctx = createExecutionContext();
		const instance = new Worker(ctx, env);

		const params = makeValidSessionMetrics();
		delete (params as Record<string, unknown>).timeToFirstResponseMs;
		await instance.ingestSessionMetrics(params);

		const call = aeSpy.writeDataPoint.mock.calls[0][0];
		expect(call.doubles[1]).toBe(-1);
	});

	it('defaults ingestVersion to 0 when omitted', async () => {
		const aeSpy = makeWriteDataPointSpy();
		const env = makeTestEnv({ O11Y_SESSION_METRICS: aeSpy as unknown as AnalyticsEngineDataset });
		const ctx = createExecutionContext();
		const instance = new Worker(ctx, env);

		const params = makeValidSessionMetrics();
		delete (params as Record<string, unknown>).ingestVersion;
		await instance.ingestSessionMetrics(params);

		const call = aeSpy.writeDataPoint.mock.calls[0][0];
		expect(call.doubles[10]).toBe(0);
	});

	it('uses empty string for missing model in AE', async () => {
		const aeSpy = makeWriteDataPointSpy();
		const env = makeTestEnv({ O11Y_SESSION_METRICS: aeSpy as unknown as AnalyticsEngineDataset });
		const ctx = createExecutionContext();
		const instance = new Worker(ctx, env);

		const params = makeValidSessionMetrics();
		delete (params as Record<string, unknown>).model;
		await instance.ingestSessionMetrics(params);

		const call = aeSpy.writeDataPoint.mock.calls[0][0];
		expect(call.blobs[4]).toBe('');
	});

	it('rejects invalid session metrics', async () => {
		const env = makeTestEnv();
		const ctx = createExecutionContext();
		const instance = new Worker(ctx, env);

		await expect(instance.ingestSessionMetrics({} as never)).rejects.toThrow();
	});
});
