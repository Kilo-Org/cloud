import { startControlServer } from './control-server';
import { log } from './logger';
import { bootHydration, getUptime } from './process-manager';

log.info('container.cold_start', { uptime: getUptime(), ts: new Date().toISOString() });

process.on('uncaughtException', err => {
  log.error('container.uncaught_exception', { error: err.message, stack: err.stack });
  process.exit(1);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received — starting graceful drain...');
});

startControlServer();

void (async () => {
  await bootHydration();
})();
