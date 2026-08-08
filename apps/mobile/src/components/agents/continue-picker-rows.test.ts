import { describe, expect, it } from 'vitest';

import { type InstancePickerInstance } from '@/lib/picker-bridge';

import { type ContinuationDestination } from './continuation-seed';
import { toContinuePickerRows } from './continue-picker-rows';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const CLOUD_DESTINATION: ContinuationDestination = {
  kind: 'cloud-agent',
  repo: 'owner/repo',
  model: 'test-model',
  variant: 'default',
};

const INSTANCE_A: InstancePickerInstance = {
  connectionId: 'c1',
  name: 'mac-mini',
  projectName: 'cloud',
};

function remote(instance: InstancePickerInstance): ContinuationDestination {
  return { kind: 'remote', instance };
}

function firstRow(destinations: readonly ContinuationDestination[]) {
  const [row] = toContinuePickerRows(destinations);
  if (!row) {
    throw new Error('Expected at least one row');
  }
  return row;
}

// ---------------------------------------------------------------------------
// toContinuePickerRows
// ---------------------------------------------------------------------------

describe('toContinuePickerRows', () => {
  it('maps a cloud-agent destination to a Cloud Agent row with the repository full name', () => {
    const row = firstRow([CLOUD_DESTINATION]);

    expect(row.icon).toBe('cloud');
    expect(row.title).toBe('Cloud Agent');
    expect(row.subtitle).toBe('owner/repo');
    expect(row.destination).toEqual(CLOUD_DESTINATION);
  });

  it('maps a remote destination to a terminal row with the instance and project names', () => {
    const destination = remote(INSTANCE_A);
    const row = firstRow([destination]);

    expect(row.icon).toBe('terminal');
    expect(row.title).toBe('mac-mini');
    expect(row.subtitle).toBe('cloud');
    expect(row.destination).toEqual(destination);
  });

  it('keeps input order for a mixed list', () => {
    const instanceB: InstancePickerInstance = {
      connectionId: 'c2',
      name: 'linux-box',
      projectName: 'prod',
    };
    const rows = toContinuePickerRows([CLOUD_DESTINATION, remote(INSTANCE_A), remote(instanceB)]);

    expect(rows.map(row => row.title)).toEqual(['Cloud Agent', 'mac-mini', 'linux-box']);
    expect(rows.map(row => row.icon)).toEqual(['cloud', 'terminal', 'terminal']);
  });

  it('gives every position a unique key, even for a duplicate connection id and a cloud-agent connection id', () => {
    const duplicateConnection: InstancePickerInstance = {
      connectionId: 'c1',
      name: 'linux-box',
      projectName: 'prod',
    };
    const cloudAgentConnection: InstancePickerInstance = {
      connectionId: 'cloud-agent',
      name: 'odd-cli',
      projectName: 'project',
    };
    const rows = toContinuePickerRows([
      CLOUD_DESTINATION,
      remote(INSTANCE_A),
      remote(duplicateConnection),
      remote(cloudAgentConnection),
    ]);

    expect(rows.map(row => row.key)).toEqual(['0', '1', '2', '3']);
    expect(new Set(rows.map(row => row.key)).size).toBe(rows.length);
  });
});
