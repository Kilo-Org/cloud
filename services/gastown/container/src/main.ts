import { startControlServer } from './control-server';
import { log } from './logger';
import { activeAgentCount, bootHydration, getUptime, listAgents } from './process-manager';

// Container-scoped identifier for crash/diagnostic logs. It can arrive at
// boot via container start options or shortly after via the first control
// request, so read it when logging instead of capturing module-init state.
function townIdForLogs(): string | null {
  return process.env.GASTOWN_TOWN_ID ?? null;
}

log.info('container.cold_start', {
  uptime: getUptime(),
  ts: new Date().toISOString(),
  townId: townIdForLogs(),
});

// Bun (like Node) will ignore unhandled promise rejections unless a handler
// is registered. Without this handler a rejection in a fire-and-forget path
// (e.g. `void saveDbSnapshot(...)`, `void subscribeToEvents(...)`,
// `setInterval(() => void fn())`) is effectively invisible — making the
// root cause of container crashes impossible to diagnose from logs.
//
// We deliberately DO NOT call process.exit here: visibility is the goal.
// If a specific rejection turns out to be fatal state corruption we can
// escalate it individually.
process.on('unhandledRejection', reason => {
  const err =
    reason instanceof Error
      ? { message: reason.message, stack: reason.stack, name: reason.name }
      : { message: String(reason) };
  log.error('container.unhandled_rejection', {
    ...err,
    townId: townIdForLogs(),
    uptimeMs: getUptime(),
    activeAgents: activeAgentCount(),
  });
});

process.on('uncaughtException', err => {
  log.error('container.uncaught_exception', {
    message: err.message,
    stack: err.stack,
    name: err.name,
    townId: townIdForLogs(),
    uptimeMs: getUptime(),
    activeAgents: activeAgentCount(),
  });
  // Keep the existing fatal behaviour for truly uncaught synchronous errors.
  // An unhandled rejection is handled separately above without exit so we
  // can observe the crash class before deciding whether to remain fatal.
  process.exit(1);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received — starting graceful drain...');
});

// Periodically log RSS memory so we can correlate OOM-class failures
// (external SIGKILL from Cloudflare Containers runtime when a memory
// ceiling is hit) with steady-state memory growth. 30s cadence matches
// the heartbeat interval and is cheap.
const MEMORY_LOG_INTERVAL_MS = 30_000;
setInterval(() => {
  try {
    const mem = process.memoryUsage();
    log.info('container.memory_usage', {
      rssMB: Math.round(mem.rss / 1024 / 1024),
      heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
      externalMB: Math.round(mem.external / 1024 / 1024),
      townId: townIdForLogs(),
      uptimeMs: getUptime(),
      agents: listAgents().length,
      activeAgents: activeAgentCount(),
    });
  } catch (err) {
    log.warn('container.memory_usage_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}, MEMORY_LOG_INTERVAL_MS);

startControlServer();

void (async () => {
  try {
    await bootHydration();
  } catch (err) {
    // bootHydration has its own try/catch for the registry fetch path but
    // the inner startAgent loop can still throw on rare synchronous errors
    // before its first await. Log rather than crash so the next /agents/start
    // request can recover.
    log.error('container.boot_hydration_failed', {
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
      townId: townIdForLogs(),
    });
  }
})();
