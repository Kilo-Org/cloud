import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, '..');
const inheritedVariables = new Set([
  'PATH',
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'SYSTEMROOT',
  'CI',
  'TERM',
  'FORCE_COLOR',
  'NO_COLOR',
]);

for (const name of Object.keys(process.env)) {
  if (!inheritedVariables.has(name)) delete process.env[name];
}
Object.assign(process.env, {
  MINIFLARE_WORKERD_PATH: require.resolve('workerd/bin/workerd'),
  CLOUDFLARE_CF_FETCH_ENABLED: 'false',
  WRANGLER_SEND_METRICS: 'false',
  CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false',
  CLOUDFLARE_INCLUDE_PROCESS_ENV: 'false',
});

const { createVitest, parseCLI } = await import('vitest/node');
const { filter, options } = parseCLI(['vitest', 'run', ...process.argv.slice(2)]);
const vitest = await createVitest('test', {
  ...options,
  root,
  config: resolve(root, 'vitest.workers.config.ts'),
  watch: false,
  passWithNoTests: false,
});
const logError = vitest.logger.error.bind(vitest.logger);
vitest.logger.error = (...args) => {
  process.exitCode ||= 1;
  logError(...args);
};
const interrupt = () => {
  process.exitCode = 130;
  void vitest.cancelCurrentRun('keyboard-input').catch(error => vitest.logger.error(error));
};
const terminate = () => {
  process.exitCode = 143;
  void vitest.cancelCurrentRun('keyboard-input').catch(error => vitest.logger.error(error));
};
process.once('SIGINT', interrupt);
process.once('SIGTERM', terminate);

try {
  const result = await vitest.start(filter);
  if (
    result.unhandledErrors.length ||
    result.testModules.some(module => module.state() === 'failed')
  ) {
    process.exitCode ||= 1;
  }
} catch (error) {
  vitest.logger.error(error);
} finally {
  await vitest.close();
  process.off('SIGINT', interrupt);
  process.off('SIGTERM', terminate);
}
