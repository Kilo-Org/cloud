/* eslint-disable typescript-eslint/consistent-type-definitions -- AGENTS.md prefers type over interface */
import { z } from 'zod';
import { isUsableStoredEndpoint } from './pairing';
import type { LocalAgentStoredEndpoint } from './pairing';
import { createSerialTaskQueue } from './storage';
import type { LocalAgentStorageArea } from './storage';

/*
 * Pairing endpoints are stored in `storage.local` so a service-worker restart
 * can redial without the user repeating pairing (SPEC "Loopback pairing").
 * Values are filtered through the loopback rules on every read: nothing
 * non-loopback and no short key is ever treated as an endpoint.
 *
 * A hub that exits never comes back under its id (every hub start has a new
 * one), so an endpoint that stays unreachable is removed: at once when a newer
 * pairing takes over its socket URL, otherwise after a day without a connection.
 * A live connection refreshes its stamp hourly, so a worker restart never finds
 * a long-connected hub looking a day old.
 */

export const LOCAL_AGENT_ENDPOINTS_STORAGE_KEY = 'local:kiloLocalAgentEndpoints';
export const LOCAL_AGENT_ENDPOINT_STALE_MS = 24 * 60 * 60 * 1000;
export const LOCAL_AGENT_ENDPOINT_REFRESH_MS = 60 * 60 * 1000;

const storedEndpointSchema = z.object({
  hubId: z.uuid(),
  key: z.string().min(1),
  lastConnectedAt: z.number().optional(),
  ws: z.string().min(1),
});

const storedEndpointsSchema = z
  .object({
    endpoints: z.array(storedEndpointSchema).default([]),
  })
  .strip();

export type { LocalAgentStoredEndpoint } from './pairing';

/** A stored endpoint and the last time its hub was reachable: paired, connected, or disconnected. */
export type LocalAgentSavedEndpoint = LocalAgentStoredEndpoint & { lastConnectedAt: number };

/* Endpoints written before the stamp existed have none until the next prune. */
type LocalAgentReadEndpoint = z.infer<typeof storedEndpointSchema>;

/* Two pairing navigations can land in the same tick; one queue keeps every
   read-modify-write on the endpoints key ordered. */
const endpointWrites = createSerialTaskQueue();

const readEndpoints = async (storage: LocalAgentStorageArea): Promise<LocalAgentReadEndpoint[]> => {
  const parsed = storedEndpointsSchema.safeParse(
    await storage.getItem(LOCAL_AGENT_ENDPOINTS_STORAGE_KEY)
  );

  if (!parsed.success) {
    return [];
  }

  const byHub = new Map<string, LocalAgentReadEndpoint>();

  for (const endpoint of parsed.data.endpoints) {
    if (isUsableStoredEndpoint(endpoint)) {
      byHub.set(endpoint.hubId, endpoint);
    }
  }

  return [...byHub.values()];
};

const writeEndpoints = async (
  storage: LocalAgentStorageArea,
  endpoints: LocalAgentReadEndpoint[]
): Promise<void> => {
  await storage.setItem(LOCAL_AGENT_ENDPOINTS_STORAGE_KEY, { endpoints });
};

export const loadLocalAgentEndpoints = (
  storage: LocalAgentStorageArea
): Promise<LocalAgentReadEndpoint[]> => readEndpoints(storage);

/**
 * Stores (or replaces by hubId) one endpoint that just paired; unusable
 * endpoints are dropped. An older endpoint on the same socket URL belongs to a
 * hub that no longer listens there, so it goes too.
 */
export const saveLocalAgentEndpoint = (
  storage: LocalAgentStorageArea,
  endpoint: LocalAgentStoredEndpoint,
  pairedAt: number
): Promise<LocalAgentReadEndpoint[]> =>
  endpointWrites(async () => {
    const current = await readEndpoints(storage);

    if (!isUsableStoredEndpoint(endpoint)) {
      return current;
    }

    const next = [
      ...current.filter(stored => stored.hubId !== endpoint.hubId && stored.ws !== endpoint.ws),
      { ...endpoint, lastConnectedAt: pairedAt },
    ];
    await writeEndpoints(storage, next);

    return next;
  });

/** Records that the hub was reachable at `at`; an endpoint removed meanwhile stays removed. */
export const touchLocalAgentEndpoint = (
  storage: LocalAgentStorageArea,
  hubId: string,
  at: number
): Promise<void> =>
  endpointWrites(async () => {
    const current = await readEndpoints(storage);
    const touched = current.find(endpoint => endpoint.hubId === hubId);

    if (touched === undefined) {
      return;
    }

    // `current` is this write's own fresh parse, so the stamp can be set in place.
    touched.lastConnectedAt = at;
    await writeEndpoints(storage, current);
  });

/**
 * The endpoints worth dialing. One not connected now that has not been
 * reachable for a day is removed; a connected one's stamp is refreshed once it
 * is an hour old; one stored without a stamp starts its clock now.
 */
export const pruneLocalAgentEndpoints = (
  storage: LocalAgentStorageArea,
  { isConnected, now }: { isConnected: (hubId: string) => boolean; now: number }
): Promise<LocalAgentSavedEndpoint[]> =>
  endpointWrites(async () => {
    const current = await readEndpoints(storage);
    let changed = false;
    const next = current.flatMap(endpoint => {
      const stamped = endpoint.lastConnectedAt ?? now;
      const age = now - stamped;
      const connected = isConnected(endpoint.hubId);

      if (!connected && age > LOCAL_AGENT_ENDPOINT_STALE_MS) {
        changed = true;

        return [];
      }

      const lastConnectedAt = connected && age > LOCAL_AGENT_ENDPOINT_REFRESH_MS ? now : stamped;

      changed ||= lastConnectedAt !== endpoint.lastConnectedAt;

      return [{ ...endpoint, lastConnectedAt }];
    });

    if (changed) {
      await writeEndpoints(storage, next);
    }

    return next;
  });
