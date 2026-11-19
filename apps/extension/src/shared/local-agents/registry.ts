/* eslint-disable typescript-eslint/consistent-type-definitions -- AGENTS.md prefers type over interface */
import { z } from 'zod';
import type { LocalAgentTransport } from './envelope';
import { LocalAgentRpcError, LOCAL_AGENT_ERROR_CODES } from './jsonrpc';
import { createSerialTaskQueue } from './storage';
import type { LocalAgentStorageArea } from './storage';

/*
 * Controller and session bookkeeping for the connected-agents list. Until the
 * browser runtime lands, this is the only state a `session.open` changes: it
 * records who is connected so the side panel can list and disconnect them.
 */

export const LOCAL_AGENT_CONTROLLERS_STORAGE_KEY = 'session:kiloLocalAgentControllers';
/** Enough disconnected controllers for every CLI the user could have running at once. */
const REVOKED_CONTROLLER_LIMIT = 64;
/** What a disconnected controller's calls answer, with the `user_stopped` code. */
export const LOCAL_AGENT_DISCONNECTED_MESSAGE = 'The user disconnected this agent.';

export type LocalAgentSessionInput = {
  sessionId: string;
  title: string;
  cwd: string;
  cliVersion: string;
};

export type LocalAgentConnectedAgent = {
  controllerId: string;
  transport: LocalAgentTransport;
  sessionHandle: string;
  sessionId: string;
  title: string;
  cwd: string;
  cliVersion: string;
};

const sessionSchema = z.object({
  cliVersion: z.string(),
  cwd: z.string(),
  openedAt: z.number(),
  sessionHandle: z.uuid(),
  sessionId: z.string(),
  title: z.string(),
});

const controllerSchema = z.object({
  connectedAt: z.number(),
  controllerId: z.uuid(),
  hubId: z.uuid().optional(),
  sessions: z.array(sessionSchema).default([]),
  transport: z.enum(['native', 'loopback']),
});

export const localAgentControllersSchema = z
  .object({
    controllers: z.array(controllerSchema).default([]),
    /* Controllers the user disconnected. The hub announces them again after every
       reconnect, so they stay refused until their CLI connection ends. */
    revoked: z.array(z.uuid()).default([]),
  })
  .strip();

export type LocalAgentSession = z.infer<typeof sessionSchema>;

export type LocalAgentController = z.infer<typeof controllerSchema>;

type LocalAgentRegistryState = z.infer<typeof localAgentControllersSchema>;

export type LocalAgentControllerRegistry = {
  listControllers(): Promise<LocalAgentController[]>;
  listConnectedAgents(): Promise<LocalAgentConnectedAgent[]>;
  /** False, and nothing recorded, for a controller the user disconnected. */
  registerController(input: {
    controllerId: string;
    transport: LocalAgentTransport;
    hubId?: string;
  }): Promise<boolean>;
  /** The controller's CLI connection ended: its row goes, and so does any refusal. */
  removeController(controllerId: string): Promise<LocalAgentController | null>;
  /** The user disconnected the controller: its row goes and it is refused from now on. */
  revokeController(controllerId: string): Promise<LocalAgentController | null>;
  openSession(
    controllerId: string,
    input: LocalAgentSessionInput
  ): Promise<{ sessionHandle: string }>;
  closeSession(controllerId: string, sessionHandle: string): Promise<boolean>;
  /** The controller that opened a session; undefined when no row holds that handle. */
  sessionOwner(sessionHandle: string): Promise<string | undefined>;
  /** Removes every session (and its controller) and reports what was revoked. */
  takeAllSessions(): Promise<{ controllerId: string; sessionHandle: string }[]>;
};

const loadRegistryState = async (
  storage: LocalAgentStorageArea
): Promise<LocalAgentRegistryState> => {
  const parsed = localAgentControllersSchema.safeParse(
    await storage.getItem(LOCAL_AGENT_CONTROLLERS_STORAGE_KEY)
  );

  return parsed.success ? parsed.data : { controllers: [], revoked: [] };
};

export const loadLocalAgentControllers = async (
  storage: LocalAgentStorageArea
): Promise<LocalAgentController[]> => {
  const { controllers } = await loadRegistryState(storage);

  return controllers;
};

const connectedAgentsOf = (controllers: LocalAgentController[]): LocalAgentConnectedAgent[] =>
  controllers.flatMap(controller =>
    controller.sessions.map(session => ({
      cliVersion: session.cliVersion,
      controllerId: controller.controllerId,
      cwd: session.cwd,
      sessionHandle: session.sessionHandle,
      sessionId: session.sessionId,
      title: session.title,
      transport: controller.transport,
    }))
  );

export const loadLocalAgentConnectedAgents = async (
  storage: LocalAgentStorageArea
): Promise<LocalAgentConnectedAgent[]> =>
  connectedAgentsOf(await loadLocalAgentControllers(storage));

const replaceSessions = (
  entry: LocalAgentController,
  sessions: LocalAgentSession[]
): LocalAgentController => ({
  connectedAt: entry.connectedAt,
  controllerId: entry.controllerId,
  sessions,
  transport: entry.transport,
  ...(entry.hubId === undefined ? {} : { hubId: entry.hubId }),
});

export const createLocalAgentControllerRegistry = ({
  createHandle,
  now,
  storage,
}: {
  createHandle: () => string;
  now: () => number;
  storage: LocalAgentStorageArea;
}): LocalAgentControllerRegistry => {
  const runExclusive = createSerialTaskQueue();

  const writeState = async (state: LocalAgentRegistryState): Promise<void> => {
    await storage.setItem(LOCAL_AGENT_CONTROLLERS_STORAGE_KEY, state);
  };

  /** Drops the controller's row; `refuse` keeps it out until its CLI connection ends. */
  const dropController = (controllerId: string, refuse: boolean) =>
    runExclusive(async () => {
      const state = await loadRegistryState(storage);
      const revoked = state.revoked.filter(entry => entry !== controllerId);

      await writeState({
        controllers: state.controllers.filter(entry => entry.controllerId !== controllerId),
        revoked: refuse ? [...revoked, controllerId].slice(-REVOKED_CONTROLLER_LIMIT) : revoked,
      });

      return state.controllers.find(entry => entry.controllerId === controllerId) ?? null;
    });

  return {
    closeSession: (controllerId, sessionHandle) =>
      runExclusive(async () => {
        const state = await loadRegistryState(storage);
        const controller = state.controllers.find(entry => entry.controllerId === controllerId);
        const remaining = controller?.sessions.filter(
          session => session.sessionHandle !== sessionHandle
        );

        if (controller === undefined || remaining === undefined) {
          return false;
        }

        const closed = remaining.length !== controller.sessions.length;

        if (closed) {
          await writeState({
            ...state,
            controllers: state.controllers.map(entry =>
              entry.controllerId === controllerId ? replaceSessions(entry, remaining) : entry
            ),
          });
        }

        return closed;
      }),

    listConnectedAgents: async () => connectedAgentsOf(await loadLocalAgentControllers(storage)),

    listControllers: () => loadLocalAgentControllers(storage),

    openSession: (controllerId, input) =>
      runExclusive(async () => {
        const state = await loadRegistryState(storage);
        const controller = state.controllers.find(entry => entry.controllerId === controllerId);

        if (controller === undefined) {
          throw state.revoked.includes(controllerId)
            ? new LocalAgentRpcError(
                LOCAL_AGENT_ERROR_CODES.userStopped,
                LOCAL_AGENT_DISCONNECTED_MESSAGE
              )
            : new LocalAgentRpcError(
                LOCAL_AGENT_ERROR_CODES.blocked,
                'This controller is not connected.'
              );
        }

        const sessionHandle = createHandle();
        await writeState({
          ...state,
          controllers: state.controllers.map(entry =>
            entry.controllerId === controllerId
              ? replaceSessions(entry, [
                  ...entry.sessions,
                  { ...input, openedAt: now(), sessionHandle },
                ])
              : entry
          ),
        });

        return { sessionHandle };
      }),

    registerController: input =>
      runExclusive(async () => {
        const state = await loadRegistryState(storage);

        if (state.revoked.includes(input.controllerId)) {
          return false;
        }

        const existing = state.controllers.find(entry => entry.controllerId === input.controllerId);
        const next: LocalAgentController = existing ?? {
          connectedAt: now(),
          controllerId: input.controllerId,
          sessions: [],
          transport: input.transport,
          ...(input.hubId === undefined ? {} : { hubId: input.hubId }),
        };

        await writeState({
          ...state,
          controllers: [
            ...state.controllers.filter(entry => entry.controllerId !== input.controllerId),
            next,
          ],
        });

        return true;
      }),

    removeController: controllerId => dropController(controllerId, false),

    revokeController: controllerId => dropController(controllerId, true),

    sessionOwner: sessionHandle =>
      runExclusive(async () => {
        const controllers = await loadLocalAgentControllers(storage);

        return controllers.find(controller =>
          controller.sessions.some(session => session.sessionHandle === sessionHandle)
        )?.controllerId;
      }),

    takeAllSessions: () =>
      runExclusive(async () => {
        const state = await loadRegistryState(storage);
        const revoked = state.controllers.flatMap(controller =>
          controller.sessions.map(session => ({
            controllerId: controller.controllerId,
            sessionHandle: session.sessionHandle,
          }))
        );

        await writeState({ ...state, controllers: [] });

        return revoked;
      }),
  };
};
