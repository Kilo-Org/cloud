import { describe, expect, it } from 'vitest';
import { projectReportedStatus } from './status-projection.js';

describe('projectReportedStatus', () => {
  it('reports off when physical is stopped', () => {
    expect(
      projectReportedStatus({ physical: 'stopped', connection: 'ready', work: 'active' })
    ).toBe('off');
  });

  it('reports booting while creating, including when disconnected', () => {
    expect(
      projectReportedStatus({
        physical: 'creating',
        connection: 'disconnected',
        work: 'idle',
      })
    ).toBe('booting');
  });

  it('reports booting while running but only connected', () => {
    expect(
      projectReportedStatus({
        physical: 'running',
        connection: 'connected',
        work: 'idle',
      })
    ).toBe('booting');
  });

  it('reports ready when running, ready, and idle', () => {
    expect(projectReportedStatus({ physical: 'running', connection: 'ready', work: 'idle' })).toBe(
      'ready'
    );
  });

  it('reports working when running, ready, and active', () => {
    expect(
      projectReportedStatus({ physical: 'running', connection: 'ready', work: 'active' })
    ).toBe('working');
  });

  it('reports finalizing when running, ready, and finalizing', () => {
    expect(
      projectReportedStatus({
        physical: 'running',
        connection: 'ready',
        work: 'finalizing',
      })
    ).toBe('finalizing');
  });

  it('reports degraded when running and disconnected', () => {
    expect(
      projectReportedStatus({
        physical: 'running',
        connection: 'disconnected',
        work: 'active',
      })
    ).toBe('degraded');
  });

  it('reports shutting-down when physical is stopping', () => {
    expect(
      projectReportedStatus({
        physical: 'stopping',
        connection: 'ready',
        work: 'idle',
      })
    ).toBe('shutting-down');
  });

  it('reports failed when physical is failed', () => {
    expect(projectReportedStatus({ physical: 'failed', connection: 'ready', work: 'idle' })).toBe(
      'failed'
    );
  });

  it('reports unknown when physical is unknown', () => {
    expect(projectReportedStatus({ physical: 'unknown', connection: 'ready', work: 'idle' })).toBe(
      'unknown'
    );
  });
});
