import { z } from 'zod';

const prefix = 'environment-build:';
export function builderNetworkSecretScope(environmentId: string): string {
  return `${prefix}${z.uuid().parse(environmentId)}`;
}

export function builderNetworkSecretEnvironmentId(scope: string): string | null {
  if (!scope.startsWith(prefix)) return null;
  const id = z.uuid().safeParse(scope.slice(prefix.length));
  return id.success ? id.data : null;
}
