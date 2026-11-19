/* eslint-disable typescript-eslint/consistent-type-definitions -- AGENTS.md prefers type over interface */
import { z } from 'zod';
import { connectionStateSchema } from './connection-state';
import type { LocalAgentStorageArea } from './storage';

/*
 * What the side panel shows about the transport. `storage.session` is correct
 * here: a status written by a dead service worker must not survive a browser
 * restart and claim a connection that no longer exists.
 */

export const LOCAL_AGENT_STATUS_STORAGE_KEY = 'session:kiloLocalAgentStatus';

const endpointStatusSchema = z.object({
  endpointId: z.string().min(1),
  hubId: z.uuid().optional(),
  state: connectionStateSchema,
  transport: z.enum(['native', 'loopback']),
});

export const localAgentStatusSchema = z
  .object({
    endpoints: z.array(endpointStatusSchema).default([]),
  })
  .strip();

export type LocalAgentEndpointStatus = z.infer<typeof endpointStatusSchema>;

export const loadLocalAgentStatus = async (
  storage: LocalAgentStorageArea
): Promise<LocalAgentEndpointStatus[]> => {
  const parsed = localAgentStatusSchema.safeParse(
    await storage.getItem(LOCAL_AGENT_STATUS_STORAGE_KEY)
  );

  return parsed.success ? parsed.data.endpoints : [];
};

export const saveLocalAgentStatus = async (
  storage: LocalAgentStorageArea,
  endpoints: LocalAgentEndpointStatus[]
): Promise<void> => {
  await storage.setItem(
    LOCAL_AGENT_STATUS_STORAGE_KEY,
    localAgentStatusSchema.parse({ endpoints })
  );
};
