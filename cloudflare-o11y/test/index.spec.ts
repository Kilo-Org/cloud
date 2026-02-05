import { createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src/index';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const TEST_CLIENT_SECRET = 'test-client-secret-value';

function makeTestEnv(): Env {
	return {
		O11Y_KILO_GATEWAY_CLIENT_SECRET: {
			get: async () => TEST_CLIENT_SECRET,
		},
		POSTHOG_API_KEY: 'phc_GK2Pxl0HPj5ZPfwhLRjXrtdz8eD7e9MKnXiFrOqnB6z',
		POSTHOG_HOST: 'https://us.i.posthog.com',
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
		const request = new IncomingRequest('https://example.com/ingest/api-metrics', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
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
				statusCode: 429,
				tokens: {
					inputTokens: 10,
					outputTokens: 20,
					cacheWriteTokens: 0,
					cacheHitTokens: 3,
					totalTokens: 30,
				},
			}),
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, makeTestEnv(), ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(204);
	});

	it('rejects unknown clientSecret', async () => {
		const request = new IncomingRequest('https://example.com/ingest/api-metrics', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				clientSecret: 'wrong-secret',
				kiloUserId: 'user_123',
				isAnonymous: false,
				isStreaming: true,
				userByok: false,
				provider: 'openai',
				requestedModel: 'kilo/auto',
				resolvedModel: 'anthropic/claude-sonnet-4.5',
				toolsAvailable: [],
				toolsUsed: [],
				ttfbMs: 45,
				completeRequestMs: 123,
				statusCode: 200,
			}),
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, makeTestEnv(), ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(403);
		const json = await response.json();
		expect(json).toMatchObject({ error: 'Unknown clientSecret' });
	});

	it('rejects missing params in /ingest/api-metrics', async () => {
		const request = new IncomingRequest('https://example.com/ingest/api-metrics', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({}),
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, makeTestEnv(), ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(400);
		const json = await response.json();
		expect(json).toMatchObject({ error: 'Invalid request body' });
	});
});
