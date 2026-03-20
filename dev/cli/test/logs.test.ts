import { describe, expect, test } from 'bun:test';
import { services } from '../src/services/registry';

/**
 * The `logs` command tails `docker compose logs -f <name>` for infra services.
 * Only infra services whose devCommand starts with "docker compose" actually
 * exist in docker-compose.yml. Non-compose infra services (e.g. migrations)
 * must NOT be passed to `docker compose logs` — they'd fail silently or error.
 *
 * These tests validate the invariants that the logs command relies on.
 */
describe('logs command invariants', () => {
  const infraServices = services.filter(s => s.type === 'infra');
  const composeInfra = infraServices.filter(s => s.devCommand?.startsWith('docker compose'));
  const nonComposeInfra = infraServices.filter(s => !s.devCommand?.startsWith('docker compose'));

  test('migrations is an infra service with a non-compose devCommand', () => {
    const migrations = services.find(s => s.name === 'migrations');
    expect(migrations).toBeDefined();
    expect(migrations!.type).toBe('infra');
    expect(migrations!.devCommand).toBe('pnpm drizzle migrate');
    expect(migrations!.devCommand!.startsWith('docker compose')).toBe(false);
  });

  test('postgres and redis are infra services with docker compose devCommands', () => {
    for (const name of ['postgres', 'redis']) {
      const svc = services.find(s => s.name === name);
      expect(svc).toBeDefined();
      expect(svc!.type).toBe('infra');
      expect(svc!.devCommand!.startsWith('docker compose')).toBe(true);
    }
  });

  test('at least one infra service is non-compose (guard against regression)', () => {
    expect(nonComposeInfra.length).toBeGreaterThanOrEqual(1);
  });

  test('compose infra services have names matching docker-compose service names', () => {
    // The logs command uses svc.name as the compose service name.
    // Compose infra devCommands should contain `-d <name>` referencing the same service.
    for (const svc of composeInfra) {
      expect(svc.devCommand).toContain(svc.name);
    }
  });
});
