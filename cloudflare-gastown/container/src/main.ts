import { startControlServer } from './control-server';
import { log } from './logger';

log.info('container.cold_start', { uptime: 0, ts: new Date().toISOString() });

process.on('uncaughtException', err => {
  log.error('container.uncaught_exception', { error: err.message, stack: err.stack });
  process.exit(1);
});

startControlServer();
