import { describe, it, expect } from 'vitest';
import {
  evaluateCapacityThresholds,
  CONTAINER_CAPACITY_THRESHOLDS,
  MONITORED_CONTAINER_APPS,
  type ContainerApplication,
} from '../src/alerting/container-capacity';

const MONITORED = MONITORED_CONTAINER_APPS[0]; // 'cloud-agent-next-sandbox'
const MONITORED_SMALL = MONITORED_CONTAINER_APPS[1]; // 'cloud-agent-next-sandboxsmall'

function makeApp(
  overrides: Partial<ContainerApplication> & Pick<ContainerApplication, 'name'>
): ContainerApplication {
  return {
    id: 'app-id-1',
    instances: 0,
    maxInstances: 100,
    ...overrides,
  };
}

describe('CONTAINER_CAPACITY_THRESHOLDS', () => {
  it('page threshold is 0.95', () => {
    expect(CONTAINER_CAPACITY_THRESHOLDS.page).toBe(0.95);
  });

  it('ticket threshold is 0.80', () => {
    expect(CONTAINER_CAPACITY_THRESHOLDS.ticket).toBe(0.8);
  });
});

describe('evaluateCapacityThresholds', () => {
  it('returns no alert at 50% utilization', () => {
    const apps = [makeApp({ name: MONITORED, instances: 50, maxInstances: 100 })];
    expect(evaluateCapacityThresholds(apps)).toEqual([]);
  });

  it('returns ticket alert at 81% utilization', () => {
    const apps = [makeApp({ name: MONITORED, instances: 81, maxInstances: 100 })];
    const alerts = evaluateCapacityThresholds(apps);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe('ticket');
    expect(alerts[0].applicationName).toBe(MONITORED);
    expect(alerts[0].usedInstances).toBe(81);
    expect(alerts[0].maxInstances).toBe(100);
    expect(alerts[0].utilizationFraction).toBeCloseTo(0.81);
    expect(alerts[0].thresholdFraction).toBe(CONTAINER_CAPACITY_THRESHOLDS.ticket);
  });

  it('returns page alert only at 96% utilization (page takes precedence over ticket)', () => {
    const apps = [makeApp({ name: MONITORED, instances: 96, maxInstances: 100 })];
    const alerts = evaluateCapacityThresholds(apps);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe('page');
    expect(alerts[0].thresholdFraction).toBe(CONTAINER_CAPACITY_THRESHOLDS.page);
  });

  it('skips app when maxInstances is 0', () => {
    const apps = [makeApp({ name: MONITORED, instances: 0, maxInstances: 0 })];
    expect(evaluateCapacityThresholds(apps)).toEqual([]);
  });

  it('skips unmonitored applications', () => {
    const apps = [makeApp({ name: 'some-unrelated-app', instances: 99, maxInstances: 100 })];
    expect(evaluateCapacityThresholds(apps)).toEqual([]);
  });

  it('returns ticket alert at exactly 80% utilization (boundary inclusive)', () => {
    const apps = [makeApp({ name: MONITORED, instances: 80, maxInstances: 100 })];
    const alerts = evaluateCapacityThresholds(apps);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe('ticket');
  });

  it('returns page alert at exactly 95% utilization (boundary inclusive)', () => {
    const apps = [makeApp({ name: MONITORED, instances: 95, maxInstances: 100 })];
    const alerts = evaluateCapacityThresholds(apps);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe('page');
  });

  it('returns no alert at 79% utilization (just below ticket threshold)', () => {
    const apps = [makeApp({ name: MONITORED, instances: 79, maxInstances: 100 })];
    expect(evaluateCapacityThresholds(apps)).toEqual([]);
  });

  it('includes health breakdown in alert when available', () => {
    const health = { instances: { active: 80, healthy: 1, starting: 0 } };
    const apps = [makeApp({ name: MONITORED, instances: 81, maxInstances: 100, health })];
    const alerts = evaluateCapacityThresholds(apps);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].health).toEqual(health.instances);
  });

  it('returns no health in alert when not provided', () => {
    const apps = [makeApp({ name: MONITORED, instances: 81, maxInstances: 100 })];
    const alerts = evaluateCapacityThresholds(apps);
    expect(alerts[0].health).toBeUndefined();
  });

  it('evaluates both monitored apps independently', () => {
    const apps = [
      makeApp({ name: MONITORED, instances: 81, maxInstances: 100 }),
      makeApp({ id: 'app-id-2', name: MONITORED_SMALL, instances: 96, maxInstances: 100 }),
    ];
    const alerts = evaluateCapacityThresholds(apps);
    expect(alerts).toHaveLength(2);
    const sandboxAlert = alerts.find(a => a.applicationName === MONITORED);
    const smallAlert = alerts.find(a => a.applicationName === MONITORED_SMALL);
    expect(sandboxAlert?.severity).toBe('ticket');
    expect(smallAlert?.severity).toBe('page');
  });
});
