import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import test from 'node:test';

import {
  AI_GATEWAY_PATH_REWRITES,
  buildAiGatewayRewrites,
  resolveAiGatewayOrigin,
} from './ai-gateway-rewrites.mjs';

const WEB_APP_DIR = join(import.meta.dirname, 'src/app');
const AI_GATEWAY_APP_DIR = join(import.meta.dirname, '../ai-gateway/src/app');

const SAMPLE_SEGMENT_VALUES = {
  '[...path]': ['chat', 'completions'],
  '[id]': ['org-id'],
  '[provider]': ['anthropic'],
  '[model]': ['claude'],
};

function listRouteDirs(appDir) {
  return readdirSync(appDir, { recursive: true })
    .filter(file => file.endsWith(`${sep}route.ts`))
    .map(file =>
      relative(appDir, join(appDir, file, '..'))
        .split(sep)
        .join('/')
    );
}

function samplePathFor(routeDir) {
  return `/${routeDir
    .split('/')
    .filter(segment => !/^\(.*\)$/.test(segment))
    .flatMap(segment => SAMPLE_SEGMENT_VALUES[segment] ?? [segment])
    .join('/')}`;
}

function matchSource(source, path) {
  const sourceSegments = source.split('/').filter(Boolean);
  const pathSegments = path.split('/').filter(Boolean);
  const params = {};
  for (const [index, segment] of sourceSegments.entries()) {
    if (segment.startsWith(':') && segment.endsWith('*')) {
      params[segment.slice(1, -1)] = pathSegments.slice(index).join('/');
      return params;
    }
    const value = pathSegments[index];
    if (value === undefined) return undefined;
    if (segment.startsWith(':')) params[segment.slice(1)] = value;
    else if (segment !== value) return undefined;
  }
  return sourceSegments.length === pathSegments.length ? params : undefined;
}

function rewritePath(path) {
  for (const { source, destination } of AI_GATEWAY_PATH_REWRITES) {
    const params = matchSource(source, path);
    if (!params) continue;
    return destination.replace(/:(\w+)\*?/g, (_, name) => params[name]);
  }
  return undefined;
}

function resolveAppRoute(appDir, path) {
  let dir = appDir;
  for (const segment of path.split('/').filter(Boolean)) {
    const entries = readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory());
    const next =
      entries.find(entry => entry.name === segment) ??
      entries.find(entry => /^\[[^.]+\]$/.test(entry.name)) ??
      entries.find(entry => entry.name.startsWith('[...'));
    if (!next) return undefined;
    dir = join(dir, next.name);
    if (next.name.startsWith('[...')) break;
  }
  const routeFile = join(dir, 'route.ts');
  return existsSync(routeFile) ? routeFile : undefined;
}

test('rewrites to the production and staging gateways by Vercel target environment', () => {
  assert.equal(
    resolveAiGatewayOrigin({ VERCEL: '1', VERCEL_TARGET_ENV: 'production' }),
    'https://ai-gateway.kilo.ai'
  );
  assert.equal(
    resolveAiGatewayOrigin({ VERCEL: '1', VERCEL_TARGET_ENV: 'staging', VERCEL_ENV: 'preview' }),
    'https://staging-ai-gateway.kilo.ai'
  );
});

test('refuses to build a Vercel deployment without a known gateway', () => {
  assert.throws(
    () => buildAiGatewayRewrites({ VERCEL: '1', VERCEL_TARGET_ENV: 'preview' }),
    /No AI gateway for Vercel target "preview"/
  );
});

test('rewrites to the local gateway outside Vercel', () => {
  assert.equal(resolveAiGatewayOrigin({}), 'http://localhost:3010');
  assert.equal(resolveAiGatewayOrigin({ KILO_PORT_OFFSET: '2100' }), 'http://localhost:5110');
});

test('AI_GATEWAY_URL overrides the gateway origin', () => {
  const rewrites = buildAiGatewayRewrites({
    AI_GATEWAY_URL: 'http://localhost:3010/ignored-path',
    VERCEL: '1',
    VERCEL_TARGET_ENV: 'preview',
  });

  assert.equal(rewrites.length, AI_GATEWAY_PATH_REWRITES.length);
  assert.ok(rewrites.every(({ destination }) => destination.startsWith('http://localhost:3010/')));
  assert.deepEqual(rewrites[0], {
    source: '/api/gateway/typesafe/v1/systemone',
    destination: 'http://localhost:3010/api/v1/systemone',
  });
});

test('collapses versioned and unversioned gateway paths onto /api/v1', () => {
  assert.equal(rewritePath('/api/gateway/v1/models'), '/api/v1/models');
  assert.equal(rewritePath('/api/gateway/models'), '/api/v1/models');
  assert.equal(rewritePath('/api/openrouter/v1/chat/completions'), '/api/v1/chat/completions');
  assert.equal(rewritePath('/api/openrouter/chat/completions'), '/api/v1/chat/completions');
  assert.equal(rewritePath('/api/gateway/typesafe/v1/systemone'), '/api/v1/systemone');
  assert.equal(rewritePath('/api/fim/completions'), '/api/v1/fim/completions');
  assert.equal(
    rewritePath('/api/organizations/org-id/models/validate'),
    '/api/v1/organizations/org-id/models/validate'
  );
});

test('every rewrite lands on an ai-gateway route', () => {
  for (const { source } of AI_GATEWAY_PATH_REWRITES) {
    const path = source.replace(':path*', 'chat/completions').replace(':id', 'org-id');
    const destination = rewritePath(path);
    assert.ok(
      resolveAppRoute(AI_GATEWAY_APP_DIR, destination),
      `${source} has no ai-gateway route`
    );
  }
});

test('every ai-gateway route is reachable through the web app gateway paths', () => {
  const gatewayRoutes = listRouteDirs(AI_GATEWAY_APP_DIR).filter(dir => dir.startsWith('api/v1/'));
  assert.ok(gatewayRoutes.length > 0);

  for (const routeDir of gatewayRoutes) {
    const gatewayPath = samplePathFor(routeDir);
    const routePath = gatewayPath.slice('/api/v1'.length);
    const webPaths =
      routeDir === 'api/v1/systemone'
        ? ['/api/gateway/typesafe/v1/systemone']
        : [`/api/gateway${routePath}`, `/api/openrouter/v1${routePath}`];
    for (const webPath of webPaths) {
      assert.equal(rewritePath(webPath), gatewayPath, `${webPath} does not reach ${routeDir}`);
    }
  }
});

test('the web app has no routes of its own under the rewritten paths', () => {
  const webRoutes = listRouteDirs(WEB_APP_DIR);
  assert.ok(webRoutes.includes('api/organizations/[id]'));

  for (const routeDir of webRoutes) {
    assert.equal(
      rewritePath(samplePathFor(routeDir)),
      undefined,
      `${routeDir} is shadowed by a rewrite`
    );
  }
});
