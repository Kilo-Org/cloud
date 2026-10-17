import { runtimeReleaseDescriptorSchema } from '../../src/shared/runtime-release.js';

export const TEST_CLI_SHA = 'a'.repeat(64);
export const TEST_CONTROL_SHA = 'b'.repeat(64);
export const TEST_RUNTIME_ORIGIN = 'https://runtime.example.com';
export const TEST_RUNTIME_DESCRIPTOR = JSON.stringify(
  runtimeReleaseDescriptorSchema.parse({
    format: 1,
    bootstrap: 1,
    platform: { os: 'linux', arch: 'x64', libc: 'glibc', cpu: 'baseline' },
    abi: 'kilo-runtime-base-v1',
    cliVersion: '1.0.0',
    cliExecutable: 'kilo',
    wrapperSdkVersion: '1.0.0',
    protocol: 'v1',
    artifacts: [
      { role: 'cli', sha256: TEST_CLI_SHA, transferBytes: 10, expandedBytes: 4, fileCount: 1 },
      {
        role: 'control',
        sha256: TEST_CONTROL_SHA,
        transferBytes: 10,
        expandedBytes: 4,
        fileCount: 1,
      },
    ],
    caps: { maxTransferBytes: 100, maxExpandedBytes: 100, maxFileCount: 10 },
    inventory: [
      ['cli', 'kilo', 0o755, 4, TEST_CLI_SHA],
      ['control', 'x/y', 0o644, 4, TEST_CONTROL_SHA],
    ],
  })
);

export function testRuntimeSelection() {
  return {
    kind: 'release' as const,
    descriptor: TEST_RUNTIME_DESCRIPTOR,
    artifactOrigin: TEST_RUNTIME_ORIGIN,
    bootstrapContract: 1 as const,
  };
}
