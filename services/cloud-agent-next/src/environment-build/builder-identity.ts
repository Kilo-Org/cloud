import { z } from 'zod';

/** All non-native providers name one physical builder per immutable build ID. */
export function builderAllocationSandboxName(buildId: string): string {
  return `ses-envbuild-${buildId.replaceAll('-', '').slice(0, 40)}`;
}

/** Broker credentials use a valid isolated logical ID, independent of the provider display name. */
export function builderSandboxIdForBuild(buildId: string): `ses-${string}` {
  const id = z.uuid().parse(buildId);
  return `ses-${id.replaceAll('-', '').toLowerCase()}`;
}
