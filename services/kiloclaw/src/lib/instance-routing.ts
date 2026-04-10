import { getActivePersonalInstance, getWorkerDb } from '../db';
import { userIdFromSandboxId } from '../auth/sandbox-id';
import {
  instanceIdFromSandboxId,
  isInstanceKeyedSandboxId,
} from '@kilocode/worker-utils/instance-id';

type ActiveInstanceIdentity = {
  id: string;
  sandboxId: string;
};

export function legacyDoKeysForIdentity(userId: string, sandboxId: string): string[] {
  const keys = new Set<string>([userId]);

  if (!isInstanceKeyedSandboxId(sandboxId)) {
    try {
      keys.add(userIdFromSandboxId(sandboxId));
    } catch {
      // Placeholder sandboxIds can exist in old tests or malformed state.
    }
  }

  return [...keys];
}

export function doKeyFromActiveInstance(instance: ActiveInstanceIdentity): string {
  return isInstanceKeyedSandboxId(instance.sandboxId)
    ? instanceIdFromSandboxId(instance.sandboxId)
    : userIdFromSandboxId(instance.sandboxId);
}

export async function resolveDoKeyForUser(
  connectionString: string | undefined,
  userId: string
): Promise<string | null> {
  if (!connectionString) return null;

  const instance = await getActivePersonalInstance(getWorkerDb(connectionString), userId);
  if (!instance) return null;

  return doKeyFromActiveInstance(instance);
}
