import { RUNTIME_BASE_ABI } from '../../../src/sandbox-control/runtime-release.js';

export const FAKE_DOWNLOADED_RUNTIME_ENV = {
  RUNTIME_STARTUP_MODE: 'downloaded',
  NATIVE_RUNTIME_IMAGE: 'runtime-free',
  RUNTIME_INTERACTIVE_ORG_IDS: undefined,
  RUNTIME_RELEASE_DESCRIPTOR: JSON.stringify({
    format: 1,
    bootstrap: 1,
    platform: { os: 'linux', arch: 'x64', libc: 'glibc', cpu: 'baseline' },
    abi: RUNTIME_BASE_ABI,
    cliVersion: '7.8.1',
    cliExecutable: 'package/bin/kilo',
    wrapperSdkVersion: '7.8.1',
    protocol: '1',
    artifacts: [
      { role: 'cli', sha256: 'a'.repeat(64), transferBytes: 1, expandedBytes: 1, fileCount: 1 },
      { role: 'control', sha256: 'b'.repeat(64), transferBytes: 1, expandedBytes: 1, fileCount: 1 },
    ],
    caps: { maxTransferBytes: 100, maxExpandedBytes: 100, maxFileCount: 10 },
    inventory: [
      ['cli', 'package/bin/kilo', 0o755, 1, 'a'.repeat(64)],
      ['control', 'usr/local/bin/wrapper', 0o755, 1, 'b'.repeat(64)],
    ],
  }),
  RUNTIME_RELEASE_BUCKET: { head: async () => ({ size: 1 }) },
};
