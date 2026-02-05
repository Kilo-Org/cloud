import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src/index';

// For now, you'll need to do something like this to get a correctly-typed
// `Request` to pass to `worker.fetch()`.
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe('Hello World worker', () => {
	it('responds with Hello World! (unit style)', async () => {
		const request = new IncomingRequest('http://example.com');
		// Create an empty context to pass to `worker.fetch()`.
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		// Wait for all `Promise`s passed to `ctx.waitUntil()` to settle before running test assertions
		await waitOnExecutionContext(ctx);
		expect(await response.text()).toMatchInlineSnapshot(`"Hello World!"`);
	});

	it('responds with Hello World! (integration style)', async () => {
		const response = await SELF.fetch('https://example.com');
		expect(await response.text()).toMatchInlineSnapshot(`"Hello World!"`);
	});

	it('validates /ingest/api-metrics payload shape', async () => {
		const response = await SELF.fetch('https://example.com/ingest/api-metrics', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
			},
			body: JSON.stringify({
				clientSecret: 'TODO',
				provider: 'openai',
				requestedModel: 'kilo/auto',
				resolvedModel: 'anthropic/claude-sonnet-4.5',
				toolsAvailable: ['function:get_weather', 'function:searchDocs'],
				toolsUsed: ['function:searchDocs'],
				ttfbMs: 45,
				completeRequestMs: 123,
				statusCode: 429,
				errorMessage: 'rate limited',
				tokens: {
					inputTokens: 10,
					outputTokens: 20,
					cacheWriteTokens: 0,
					cacheHitTokens: 3,
					totalTokens: 30,
				},
			}),
		});

		expect(response.status).toBe(204);
	});

	it('rejects missing params in /ingest/api-metrics', async () => {
		const response = await SELF.fetch('https://example.com/ingest/api-metrics', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
			},
			body: JSON.stringify({}),
		});

		expect(response.status).toBe(400);
		const json = await response.json();
		expect(json).toMatchObject({ error: 'Invalid request body' });
	});
});
