import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import { getAiGatewayRewrites } from '../../apps/web/ai-gateway-rewrites.mjs';

const require = createRequire(new URL('../../apps/web/next.config.mjs', import.meta.url));
const { getPathMatch } = require('next/dist/shared/lib/router/utils/path-match');
const { prepareDestination } = require('next/dist/shared/lib/router/utils/prepare-destination');

function rewrite(url: string, env: NodeJS.ProcessEnv) {
  const request = new URL(url, 'http://localhost');
  for (const rule of getAiGatewayRewrites(env)) {
    const params = getPathMatch(rule.source)(request.pathname);
    if (params) {
      return prepareDestination({
        destination: rule.destination,
        params,
        query: Object.fromEntries(request.searchParams),
        appendParamsToQuery: true,
      }).parsedDestination;
    }
  }
  return undefined;
}

const routes = [
  ...['gateway', 'openrouter'].flatMap(prefix => [
    ...['chat/completions', 'responses', 'messages', 'audio/transcriptions', 'transcription-models']
      .flatMap(endpoint => [endpoint, `v1/${endpoint}`])
      .map(endpoint => [`/api/${prefix}/${endpoint}`, `/api/v1/${endpoint.replace(/^v1\//, '')}`]),
    ...['models-by-provider', 'providers', 'embeddings'].map(endpoint => [
      `/api/${prefix}/${endpoint}`,
      `/api/v1/${endpoint}`,
    ]),
    ...['models', 'v1/models'].map(endpoint => [
      `/api/${prefix}/${endpoint}/anthropic/claude-sonnet-4/endpoints`,
      '/api/v1/models/anthropic/claude-sonnet-4/endpoints',
    ]),
    [`/api/${prefix}/models`, '/api/v1/models'],
  ]),
  ['/api/gateway/v1/models', '/api/v1/models'],
  ['/api/gateway/embedding-models', '/api/v1/embedding-models'],
  ['/api/openrouter/models/validate', '/api/v1/models/validate'],
  ['/api/gateway/typesafe/v1/systemone', '/api/v1/systemone'],
  ['/api/fim/completions', '/api/v1/fim/completions'],
  ['/api/edit/completions', '/api/v1/edit/completions'],
  ['/api/organizations/org-123/models', '/api/v1/organizations/org-123/models'],
  ['/api/organizations/org-123/models/validate', '/api/v1/organizations/org-123/models/validate'],
];

for (const globalBackend of ['true', 'false']) {
  void test(`rewrites every legacy gateway route in production with GLOBAL_KILO_BACKEND=${globalBackend}`, () => {
    const env = {
      NODE_ENV: 'production',
      VERCEL_ENV: 'production',
      VERCEL_TARGET_ENV: 'production',
      GLOBAL_KILO_BACKEND: globalBackend,
      AI_GATEWAY_PORT: '9999',
      KILO_PORT_OFFSET: '2500',
    };
    for (const [source, destination] of routes) {
      const result = rewrite(`${source}?source=extension&stream=true`, env);
      assert.equal(result?.protocol, 'https:', source);
      assert.equal(result?.hostname, 'ai-gateway.kilo.ai', source);
      assert.equal(result?.pathname, destination, source);
      assert.deepEqual(result?.query, { source: 'extension', stream: 'true' }, source);
    }
  });

  void test(`rewrites every legacy gateway route in staging with GLOBAL_KILO_BACKEND=${globalBackend}`, () => {
    for (const vercelEnv of ['preview', 'production']) {
      const env = {
        NODE_ENV: 'production',
        VERCEL_ENV: vercelEnv,
        VERCEL_TARGET_ENV: 'staging',
        GLOBAL_KILO_BACKEND: globalBackend,
      };
      for (const [source, destination] of routes) {
        const result = rewrite(`${source}?source=extension&stream=true`, env);
        assert.equal(result?.protocol, 'https:', source);
        assert.equal(result?.hostname, 'staging-ai-gateway.kilo.ai', source);
        assert.equal(result?.pathname, destination, source);
        assert.deepEqual(result?.query, { source: 'extension', stream: 'true' }, source);
      }
    }
  });
}

void test('rewrites to the local gateway with default, offset, and explicit ports', () => {
  for (const [env, port] of [
    [{}, '3010'],
    [{ KILO_PORT_OFFSET: '2500' }, '5510'],
    [{ KILO_PORT_OFFSET: '2500', AI_GATEWAY_PORT: '6000' }, '6000'],
  ] as const) {
    for (const [source, destination] of routes) {
      const result = rewrite(source, {
        ...env,
        NODE_ENV: 'development',
        VERCEL_ENV: 'production',
        VERCEL_TARGET_ENV: 'staging',
      });
      assert.equal(result?.protocol, 'http:', source);
      assert.equal(result?.hostname, 'localhost', source);
      assert.equal(result?.port, port, source);
      assert.equal(result?.pathname, destination, source);
    }
  }
});

void test('leaves preview, test, and non-Vercel production handlers on the web app', () => {
  for (const env of [
    { NODE_ENV: 'production', VERCEL_ENV: 'preview' },
    { NODE_ENV: 'production', VERCEL_ENV: 'preview', VERCEL_TARGET_ENV: 'preview' },
    { NODE_ENV: 'production', VERCEL_ENV: 'development' },
    { NODE_ENV: 'production' },
    { NODE_ENV: 'test' },
  ]) {
    assert.deepEqual(getAiGatewayRewrites(env), []);
  }
});

void test('does not move unrelated organization, Exa, marketplace, or cron routes to the gateway', () => {
  for (const source of [
    '/api/organizations',
    '/api/organizations/org-123',
    '/api/organizations/org-123/defaults',
    '/api/organizations/org-123/modes',
    '/api/organizations/org-123/tokens',
    '/api/exa/search',
    '/api/marketplace/mcps',
    '/api/cron/sync-model-stats',
  ]) {
    assert.equal(rewrite(source, { NODE_ENV: 'production', VERCEL_ENV: 'production' }), undefined);
  }
});

void test('preserves encoded model paths and trailing slashes', () => {
  const result = rewrite('/api/gateway/v1/models/provider/model%2Fvariant/endpoints/', {
    NODE_ENV: 'production',
    VERCEL_ENV: 'production',
  });
  assert.equal(result?.pathname, '/api/v1/models/provider/model%2Fvariant/endpoints');
});
