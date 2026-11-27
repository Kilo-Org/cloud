import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { checkRepository, checkSentrySource, findSentryInitCalls } from './sentry-init-guard.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

const scrubbedNextjsInit = `
import { httpIntegration, init } from '@sentry/nextjs';
import { scrubSentryBreadcrumb, scrubSentryEvent } from '@kilocode/web-shared/lib/observability/sentry-event-scrub';

// No consoleLoggingIntegration: the SDK formats console arguments first...
init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  release: '...',
  integrations: [...defaultIntegrations, httpIntegration({ spans: false })],
  beforeSend(event) {
    event.tags = { ...event.tags, source: 'web' };
    return scrubSentryEvent(event);
  },
  beforeBreadcrumb: scrubSentryBreadcrumb,
});
`;

// The edge initializer before the shared scrub: it stripped request data only.
const oldEdgeInit = `
import { consoleLoggingIntegration, init } from '@sentry/nextjs';
import { sanitizeSentryRequestData } from '@kilocode/web-shared/lib/observability/sentry-request-data';

if (process.env.NODE_ENV !== 'development') {
  init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    integrations: [
      consoleLoggingIntegration({ levels: ['log', 'error', 'warn'] }),
    ],
    beforeSend(event) {
      sanitizeSentryRequestData(event);
      return event;
    },
  });
}
`;

test('the repository passes and the known init sites are found', () => {
  const { violations, initSites } = checkRepository(repoRoot);
  assert.deepEqual(violations, []);
  for (const site of [
    'apps/web/sentry.edge.config.ts:@sentry/nextjs',
    'packages/web-shared/src/lib/observability/sentry-server.ts:@sentry/nextjs',
    'apps/mobile/src/lib/sentry-init.ts:@sentry/react-native',
  ]) {
    assert.ok(initSites.includes(site), `init site found: ${site}`);
  }
});

test('a nextjs init that calls the shared event scrub passes', () => {
  assert.deepEqual(checkSentrySource('apps/web/sentry.edge.config.ts', scrubbedNextjsInit), []);
});

test('the old edge initializer fails on beforeSend and console logging', () => {
  assert.deepEqual(checkSentrySource('apps/web/sentry.edge.config.ts', oldEdgeInit), [
    'apps/web/sentry.edge.config.ts:2: consoleLoggingIntegration must not be used: the SDK formats console arguments into the log body before beforeSendLog runs',
    'apps/web/sentry.edge.config.ts:6: beforeSend must call scrubSentryEvent',
    'apps/web/sentry.edge.config.ts:6: beforeBreadcrumb must call scrubSentryBreadcrumb',
  ]);
});

test('a nextjs init without the shared breadcrumb scrub fails', () => {
  const source = scrubbedNextjsInit.replace('  beforeBreadcrumb: scrubSentryBreadcrumb,\n', '');
  assert.deepEqual(checkSentrySource('a.ts', source), [
    'a.ts:6: beforeBreadcrumb must call scrubSentryBreadcrumb',
  ]);
});

test('a commented-out hook does not count', () => {
  for (const [hook, message] of [
    [
      '  beforeBreadcrumb: scrubSentryBreadcrumb,\n',
      'beforeBreadcrumb must call scrubSentryBreadcrumb',
    ],
    ['  beforeSend(event) {\n', 'beforeSend must call scrubSentryEvent'],
  ]) {
    const lineComment = scrubbedNextjsInit.replace(hook, `  // ${hook.trimStart()}`);
    const blockComment = scrubbedNextjsInit.replace(hook, `  /* ${hook.trim()} */\n`);
    const quoted = scrubbedNextjsInit.replace(hook, `  note: '${hook.trim()}',\n`);
    for (const source of [lineComment, blockComment, quoted]) {
      assert.ok(
        checkSentrySource('a.ts', source).includes(`a.ts:6: ${message}`),
        `${message} for ${JSON.stringify(source.slice(source.indexOf('init(')))}`
      );
    }
  }
});

test('a nextjs init with options passed through a variable fails', () => {
  const source = `import * as Sentry from '@sentry/nextjs';\nSentry.init(options);\n`;
  assert.deepEqual(checkSentrySource('a.ts', source), [
    'a.ts:2: pass the options as an inline object so beforeSend and beforeBreadcrumb can be checked',
  ]);
});

for (const [name, options] of [
  [
    'after the hooks',
    '{ beforeSend: scrubSentryEvent, beforeBreadcrumb: scrubSentryBreadcrumb, ...overrides }',
  ],
  [
    'before the hooks',
    '{ ...base, beforeSend: scrubSentryEvent, beforeBreadcrumb: scrubSentryBreadcrumb }',
  ],
  [
    'of a call result',
    '{\n  beforeSend: scrubSentryEvent,\n  beforeBreadcrumb: scrubSentryBreadcrumb,\n  ...(enabled ? extra : {}),\n}',
  ],
]) {
  test(`a nextjs init with a top-level spread ${name} fails`, () => {
    const source = `import { init } from '@sentry/nextjs';\ninit(${options});\n`;
    assert.deepEqual(checkSentrySource('a.ts', source), [
      'a.ts:2: init options must not spread another object: it can replace the scrub hooks',
    ]);
  });
}

test('a comment or string that names console logging passes', () => {
  const source = scrubbedNextjsInit
    .replace('// No consoleLoggingIntegration', '// No consoleLoggingIntegration()')
    .replace("release: '...',", "release: 'consoleLoggingIntegration()',")
    .concat('/* import { consoleLoggingIntegration } from "@sentry/nextjs"; */\n');
  assert.deepEqual(checkSentrySource('apps/web/sentry.edge.config.ts', source), []);
});

test('console logging fails in any web Sentry file, not only in an init call', () => {
  const source = `import * as Sentry from '@sentry/nextjs';
export const integrations = [Sentry.consoleLoggingIntegration()];
`;
  for (const file of [
    'apps/web/src/lib/sentry-integrations.ts',
    'apps/ai-gateway/src/lib/x.ts',
    'packages/web-shared/src/lib/x.ts',
  ]) {
    assert.deepEqual(checkSentrySource(file, source), [
      `${file}:2: consoleLoggingIntegration must not be used: the SDK formats console arguments into the log body before beforeSendLog runs`,
    ]);
  }
  const aliased = `import { consoleLoggingIntegration as consoleLogs } from '@sentry/nextjs';\n`;
  assert.equal(checkSentrySource('apps/web/a.ts', aliased).length, 1);
});

test('sendDefaultPii set to true fails in any file', () => {
  const source = `export const options = {\n  sendDefaultPii: true,\n};\n`;
  assert.deepEqual(checkSentrySource('b.ts', source), ['b.ts:2: sendDefaultPii must not be true']);
  assert.deepEqual(checkSentrySource('b.ts', 'const o = { sendDefaultPii: false };'), []);
});

test('consoleLoggingIntegration without beforeSendLog fails for other SDKs', () => {
  const source = `import * as Sentry from '@sentry/node';
Sentry.init({ integrations: [Sentry.consoleLoggingIntegration()] });
`;
  assert.deepEqual(checkSentrySource('c.ts', source), [
    'c.ts:2: consoleLoggingIntegration requires beforeSendLog',
  ]);
  const withHook = source.replace('] }', '], beforeSendLog: scrubLog }');
  assert.deepEqual(checkSentrySource('c.ts', withHook), []);
});

test('only init calls imported from a Sentry SDK are read', () => {
  const aliased = `import { init as sentryInit } from '@sentry/cloudflare';\nsentryInit({ dsn });\n`;
  assert.equal(findSentryInitCalls(aliased).length, 1);
  const local = `import * as Sentry from '@sentry/react-native';\nfunction init() {}\ninit();\nclient.init();\n`;
  assert.equal(findSentryInitCalls(local).length, 0);
  const typeOnly = `import type { init } from '@sentry/nextjs';\ninit({});\n`;
  assert.equal(findSentryInitCalls(typeOnly).length, 0);
});
