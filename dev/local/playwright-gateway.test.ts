import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';

void test('Playwright starts both apps with shared test settings and matching gateway ports', () => {
  const webDir = path.resolve(import.meta.dirname, '../../apps/web');
  for (const gatewayPort of [undefined, '5620']) {
    const output = execFileSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `
          import { createRequire } from 'node:module';
          const require = createRequire(import.meta.url);
          const config = require('./playwright.config.ts').default;
          const [gateway, web] = config.webServer;
          console.log(JSON.stringify({
            gatewayCommand: gateway.command,
            gatewayUrl: gateway.url,
            webCommand: web.command,
            sharedEnvironment: gateway.env === web.env,
            env: {
              NODE_ENV: web.env.NODE_ENV,
              PORT: web.env.PORT,
              AI_GATEWAY_PORT: web.env.AI_GATEWAY_PORT,
              APP_URL_OVERRIDE: web.env.APP_URL_OVERRIDE,
              NEXTAUTH_URL: web.env.NEXTAUTH_URL,
              VERCEL_ENV: web.env.VERCEL_ENV,
              VERCEL_TARGET_ENV: web.env.VERCEL_TARGET_ENV,
            },
          }));
        `,
      ],
      {
        cwd: webDir,
        env: { ...process.env, PORT: '5500', AI_GATEWAY_PORT: gatewayPort },
        encoding: 'utf8',
      }
    );
    const result = JSON.parse(output.trim().split('\n').at(-1) ?? '');
    const expectedPort = gatewayPort ?? '5510';

    assert.equal(
      result.gatewayCommand,
      `pnpm --filter ai-gateway exec next dev -p ${expectedPort}`
    );
    assert.equal(
      result.gatewayUrl,
      `http://localhost:${expectedPort}/api/v1/organizations/playwright/models`
    );
    assert.match(result.webCommand, /next dev -p 5500$/);
    assert.equal(result.sharedEnvironment, true);
    assert.deepEqual(result.env, {
      NODE_ENV: 'development',
      PORT: '5500',
      AI_GATEWAY_PORT: expectedPort,
      APP_URL_OVERRIDE: 'http://localhost:5500',
      NEXTAUTH_URL: 'http://localhost:5500',
      VERCEL_ENV: '',
      VERCEL_TARGET_ENV: '',
    });
  }
});
