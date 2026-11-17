/* eslint-disable typescript-eslint/consistent-type-definitions -- AGENTS.md prefers type over interface */
import { z } from 'zod';
import { isUsablePairingEndpoint } from './pairing';
import type { LocalAgentPairingEndpoint } from './pairing';
import { createSerialTaskQueue } from './storage';
import type { LocalAgentStorageArea } from './storage';

/*
 * Pairing endpoints are stored in `storage.local` so a service-worker restart
 * can redial without the user repeating pairing (SPEC "Loopback pairing").
 * Values are filtered through the loopback rules on every read: nothing
 * non-loopback and no short key is ever treated as an endpoint.
 */

export const LOCAL_AGENT_ENDPOINTS_STORAGE_KEY = 'local:kiloLocalAgentEndpoints';

const storedEndpointSchema = z.object({
  hubId: z.uuid(),
  key: z.string().min(1),
  ws: z.string().min(1),
});

const storedEndpointsSchema = z
  .object({
    endpoints: z.array(storedEndpointSchema).default([]),
  })
  .strip();

export type LocalAgentStoredEndpoint = z.infer<typeof storedEndpointSchema>;

/* Two pairing navigations can land in the same tick; one queue keeps every
   read-modify-write on the endpoints key ordered. */
const endpointWrites = createSerialTaskQueue();

const readEndpoints = async (
  storage: LocalAgentStorageArea
): Promise<LocalAgentStoredEndpoint[]> => {
  const parsed = storedEndpointsSchema.safeParse(
    await storage.getItem(LOCAL_AGENT_ENDPOINTS_STORAGE_KEY)
  );

  if (!parsed.success) {
    return [];
  }

  const byHub = new Map<string, LocalAgentStoredEndpoint>();

  for (const endpoint of parsed.data.endpoints) {
    if (isUsablePairingEndpoint(endpoint)) {
      byHub.set(endpoint.hubId, endpoint);
    }
  }

  return [...byHub.values()];
};

const writeEndpoints = async (
  storage: LocalAgentStorageArea,
  endpoints: LocalAgentStoredEndpoint[]
): Promise<void> => {
  await storage.setItem(LOCAL_AGENT_ENDPOINTS_STORAGE_KEY, { endpoints });
};

export const loadLocalAgentEndpoints = (
  storage: LocalAgentStorageArea
): Promise<LocalAgentStoredEndpoint[]> => readEndpoints(storage);

/** Stores (or replaces by hubId) one endpoint; unusable endpoints are dropped. */
export const saveLocalAgentEndpoint = (
  storage: LocalAgentStorageArea,
  endpoint: LocalAgentPairingEndpoint
): Promise<LocalAgentStoredEndpoint[]> =>
  endpointWrites(async () => {
    const current = await readEndpoints(storage);

    if (!isUsablePairingEndpoint(endpoint)) {
      return current;
    }

    const next = [...current.filter(stored => stored.hubId !== endpoint.hubId), endpoint];
    await writeEndpoints(storage, next);

    return next;
  });

export const removeLocalAgentEndpoint = (
  storage: LocalAgentStorageArea,
  hubId: string
): Promise<LocalAgentStoredEndpoint[]> =>
  endpointWrites(async () => {
    const current = await readEndpoints(storage);
    const next = current.filter(endpoint => endpoint.hubId !== hubId);
    await writeEndpoints(storage, next);

    return next;
  });
