import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  RUNTIME_DESCRIPTOR_MAX_BYTES,
  serializeRuntimeRelease,
  type RuntimeInventoryEntry,
  type RuntimeReleaseDescriptor,
} from './runtime-release.js';

// Measured identity of @kilocode/cli-linux-x64-baseline@7.8.1 (plan §2/§6).
const CLI_SHA = '2e0de8a1f786de31d27d7f8a1c0d35e468b1ee3af66826c1b5f15658acbb1f79';
const CLI_TRANSFER_BYTES = 64_318_335;
const CLI_EXPANDED_BYTES = 237_895_845;
const CLI_FILE_COUNT = 419;
const CONTROL_SHA = 'b'.repeat(64);
const CONTROL_BYTES = 1_048_576;
const CONTROL_FILE_COUNT = 5;

function shaFor(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * A representative CLI inventory with the measured file count and expanded size.
 * Path lengths average the ~33 characters implied by the measured 50,429-byte
 * compact inventory, so the descriptor cap assertion is meaningful rather than
 * trivially small.
 */
function cliInventory(): RuntimeInventoryEntry[] {
  const entries: RuntimeInventoryEntry[] = [];
  const base = Math.floor(CLI_EXPANDED_BYTES / CLI_FILE_COUNT);
  let assigned = 0;
  for (let index = 0; index < CLI_FILE_COUNT; index += 1) {
    const name =
      index === 0
        ? 'package/bin/kilo'
        : `package/lib/${index.toString(16).padStart(6, '0')}/${'f'.repeat(8)}.js`;
    const size = index === CLI_FILE_COUNT - 1 ? CLI_EXPANDED_BYTES - assigned : base;
    assigned += size;
    entries.push(['cli', name, index === 0 ? 0o100755 : 0o100644, size, shaFor(name)]);
  }
  return entries;
}

function controlInventory(): RuntimeInventoryEntry[] {
  const names = [
    'usr/local/bin/kilocode-control-plane-wrapper.js',
    'usr/local/bin/kilo-restore-session.js',
    'usr/local/bin/bb',
    'usr/local/bin/github-review-publish-mcp',
    'usr/local/bin/kilocode-control-plane-supervisor.sh',
  ];
  const base = Math.floor(CONTROL_BYTES / names.length);
  let assigned = 0;
  return names.map((name, index) => {
    const size = index === names.length - 1 ? CONTROL_BYTES - assigned : base;
    assigned += size;
    return ['control', name, 0o100755, size, shaFor(name)] as RuntimeInventoryEntry;
  });
}

function descriptor(): RuntimeReleaseDescriptor {
  return {
    format: 1,
    bootstrap: 1,
    platform: { os: 'linux', arch: 'x64', libc: 'glibc', cpu: 'baseline' },
    abi: 'bun-1.3.14',
    cliVersion: '7.8.1',
    cliExecutable: 'package/bin/kilo',
    wrapperSdkVersion: '7.8.1',
    protocol: 'control-plane-v1',
    artifacts: [
      {
        role: 'cli',
        sha256: CLI_SHA,
        transferBytes: CLI_TRANSFER_BYTES,
        expandedBytes: CLI_EXPANDED_BYTES,
        fileCount: CLI_FILE_COUNT,
      },
      {
        role: 'control',
        sha256: CONTROL_SHA,
        transferBytes: CONTROL_BYTES,
        expandedBytes: CONTROL_BYTES,
        fileCount: CONTROL_FILE_COUNT,
      },
    ],
    caps: {
      maxTransferBytes: 256 * 1024 * 1024,
      maxExpandedBytes: 256 * 1024 * 1024,
      maxFileCount: 2_000,
    },
    inventory: [...cliInventory(), ...controlInventory()],
  };
}

describe('runtime release descriptor', () => {
  it('serializes the compact descriptor within the 64 KiB launch cap', () => {
    const bytes = serializeRuntimeRelease(descriptor());
    expect(bytes.byteLength).toBeLessThanOrEqual(RUNTIME_DESCRIPTOR_MAX_BYTES);
  });
});
