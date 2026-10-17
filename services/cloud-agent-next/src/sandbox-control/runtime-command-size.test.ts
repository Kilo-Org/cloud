import { expect, it } from 'vitest';
import { TEST_RUNTIME_DESCRIPTOR } from '../../test/helpers/runtime-release.js';
import {
  parseRuntimeRelease,
  runtimeArtifactForRole,
  serializeRuntimeRelease,
} from '../shared/runtime-release.js';
import { runtimeLaunchStartCommand } from './runtime-launch.js';
import { RuntimeInstallerError } from './runtime-release-loader.js';

it('rejects a valid descriptor whose escaped startup argument exceeds Linux limits', () => {
  const descriptor = parseRuntimeRelease(TEST_RUNTIME_DESCRIPTOR);
  for (let index = 0; index < 8; index++) {
    descriptor.inventory.push([
      'control',
      `${index}${"'".repeat(4_000)}`,
      0o644,
      0,
      'b'.repeat(64),
    ]);
  }
  runtimeArtifactForRole(descriptor, 'control').fileCount += 8;
  const source = new TextDecoder().decode(serializeRuntimeRelease(descriptor));
  let failure: unknown;
  try {
    runtimeLaunchStartCommand({
      launchId: 'launch-size-check',
      deadlineAt: Date.now() + 90_000,
      failureRetention: true,
      descriptor: source,
      origin: 'https://runtime.example.com',
      grant: 'synthetic-size-check',
    });
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(RuntimeInstallerError);
  expect(failure).toMatchObject({
    reason: 'runtime_artifact_integrity',
    message: expect.stringContaining('single-argument'),
  });
});
