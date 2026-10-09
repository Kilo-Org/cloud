import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  applyManagedWorkloadLimits,
  computeWorkloadBudget,
  DEFAULT_CONTROL_RESERVE_BYTES,
  KILO_SERVER_MIN_BYTES,
} from './workload-cgroup.js';

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function budget(input: { limits?: (number | undefined)[]; explicitLimitBytes?: number }) {
  return computeWorkloadBudget({
    limits: input.limits ?? [],
    ...(input.explicitLimitBytes !== undefined
      ? { explicitLimitBytes: input.explicitLimitBytes }
      : {}),
    reserveBytes: DEFAULT_CONTROL_RESERVE_BYTES,
  });
}

describe('computeWorkloadBudget', () => {
  it('keeps 1 GiB for the wrapper and 1.5 GiB that tools cannot take on 8 GiB', () => {
    expect(budget({ explicitLimitBytes: 8192 * MiB })).toEqual({
      ok: true,
      containerLimitBytes: 8192 * MiB,
      aggregateMaxBytes: 7168 * MiB,
      toolsMaxBytes: 5632 * MiB,
      source: 'explicit',
    });
  });

  it('gives tools the remainder on 12 GiB', () => {
    expect(budget({ explicitLimitBytes: 12_288 * MiB })).toMatchObject({
      ok: true,
      aggregateMaxBytes: 11 * GiB,
      toolsMaxBytes: 9728 * MiB,
    });
  });

  it('derives the tools cap from a smaller ancestor limit', () => {
    expect(budget({ limits: [undefined, 4 * GiB], explicitLimitBytes: 8 * GiB })).toMatchObject({
      ok: true,
      containerLimitBytes: 4 * GiB,
      aggregateMaxBytes: 3 * GiB,
      toolsMaxBytes: 1536 * MiB,
      source: 'cgroup',
    });
  });

  it('refuses a container too small to leave tools 1 GiB', () => {
    expect(budget({ explicitLimitBytes: 3 * GiB })).toEqual({
      ok: false,
      failure: 'below_minimum',
    });
  });
});

describe('applyManagedWorkloadLimits', () => {
  function scope() {
    const parent = mkdtempSync(path.join(tmpdir(), 'workload-limits-'));
    directories.push(parent);
    const server = path.join(parent, 'server');
    const tools = path.join(parent, 'tools');
    mkdirSync(server);
    mkdirSync(tools);
    return { parent, server, tools };
  }

  it('caps tools below the shared parent and kills only the largest tool on OOM', () => {
    const { parent, server, tools } = scope();

    applyManagedWorkloadLimits({
      parentReference: parent,
      serverReference: server,
      toolsReference: tools,
      toolsMaxBytes: 5632 * MiB,
    });

    expect(readFileSync(path.join(tools, 'memory.max'), 'utf8')).toBe(String(5632 * MiB));
    expect(readFileSync(path.join(tools, 'memory.oom.group'), 'utf8')).toBe('0');
    expect(readFileSync(path.join(tools, 'memory.swap.max'), 'utf8')).toBe('0');
    expect(readFileSync(path.join(server, 'memory.oom.group'), 'utf8')).toBe('0');
  });

  it('protects Kilo from reclaim at the shared cap through the scope group and the server', () => {
    const { parent, server, tools } = scope();

    const applied = applyManagedWorkloadLimits({
      parentReference: parent,
      serverReference: server,
      toolsReference: tools,
      toolsMaxBytes: 5632 * MiB,
    });

    expect(applied.serverProtection).toEqual({ ok: true, bytes: KILO_SERVER_MIN_BYTES });
    expect(readFileSync(path.join(parent, 'memory.min'), 'utf8')).toBe(
      String(KILO_SERVER_MIN_BYTES)
    );
    expect(readFileSync(path.join(server, 'memory.min'), 'utf8')).toBe(
      String(KILO_SERVER_MIN_BYTES)
    );
  });

  it('keeps the hard caps and reports the failure when memory.min cannot be written', () => {
    const { parent, server, tools } = scope();
    mkdirSync(path.join(server, 'memory.min'));

    const applied = applyManagedWorkloadLimits({
      parentReference: parent,
      serverReference: server,
      toolsReference: tools,
      toolsMaxBytes: 5632 * MiB,
    });

    expect(applied.serverProtection).toEqual({ ok: false, failure: 'write_failed' });
    expect(readFileSync(path.join(tools, 'memory.max'), 'utf8')).toBe(String(5632 * MiB));
  });
});
