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
  })
  .strip();

export type LocalAgentSession = z.infer<typeof sessionSchema>;

export type LocalAgentController = z.infer<typeof controllerSchema>;

export type LocalAgentControllerRegistry = {
  listControllers(): Promise<LocalAgentController[]>;
  listConnectedAgents(): Promise<LocalAgentConnectedAgent[]>;
  registerController(input: {
    controllerId: string;
    transport: LocalAgentTransport;
    hubId?: string;
  }): Promise<void>;
  removeController(controllerId: string): Promise<LocalAgentController | null>;
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

export const loadLocalAgentControllers = async (
  storage: LocalAgentStorageArea
): Promise<LocalAgentController[]> => {
  const parsed = localAgentControllersSchema.safeParse(
    await storage.getItem(LOCAL_AGENT_CONTROLLERS_STORAGE_KEY)
  );

  return parsed.success ? parsed.data.controllers : [];
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

  const readControllers = (): Promise<LocalAgentController[]> => loadLocalAgentControllers(storage);

  const writeControllers = async (controllers: LocalAgentController[]): Promise<void> => {
    await storage.setItem(LOCAL_AGENT_CONTROLLERS_STORAGE_KEY, { controllers });
  };

  const listControllers = (): Promise<LocalAgentController[]> => readControllers();

  return {
    closeSession: (controllerId, sessionHandle) =>
      runExclusive(async () => {
        const controllers = await readControllers();
        const controller = controllers.find(entry => entry.controllerId === controllerId);
        const remaining = controller?.sessions.filter(
          session => session.sessionHandle !== sessionHandle
        );

        if (controller === undefined || remaining === undefined) {
          return false;
        }

        const closed = remaining.length !== controller.sessions.length;

        if (closed) {
          await writeControllers(
            controllers.map(entry =>
              entry.controllerId === controllerId ? replaceSessions(entry, remaining) : entry
            )
          );
        }

        return closed;
      }),

    listConnectedAgents: async () => connectedAgentsOf(await readControllers()),

    listControllers,

    openSession: (controllerId, input) =>
      runExclusive(async () => {
        const controllers = await readControllers();
        const controller = controllers.find(entry => entry.controllerId === controllerId);

        if (controller === undefined) {
          throw new LocalAgentRpcError(
            LOCAL_AGENT_ERROR_CODES.blocked,
            'This controller is not connected.'
          );
        }

        const sessionHandle = createHandle();
        await writeControllers(
          controllers.map(entry =>
            entry.controllerId === controllerId
              ? replaceSessions(entry, [
                  ...entry.sessions,
                  { ...input, openedAt: now(), sessionHandle },
                ])
              : entry
          )
        );

        return { sessionHandle };
      }),

    registerController: input =>
      runExclusive(async () => {
        const controllers = await readControllers();
        const existing = controllers.find(entry => entry.controllerId === input.controllerId);
        const next: LocalAgentController = existing ?? {
          connectedAt: now(),
          controllerId: input.controllerId,
          sessions: [],
          transport: input.transport,
          ...(input.hubId === undefined ? {} : { hubId: input.hubId }),
        };

        await writeControllers([
          ...controllers.filter(entry => entry.controllerId !== input.controllerId),
          next,
        ]);
      }),

    removeController: controllerId =>
      runExclusive(async () => {
        const controllers = await readControllers();
        const removed = controllers.find(entry => entry.controllerId === controllerId);

        if (removed === undefined) {
          return null;
        }

        await writeControllers(controllers.filter(entry => entry.controllerId !== controllerId));

        return removed;
      }),

    takeAllSessions: () =>
      runExclusive(async () => {
        const controllers = await readControllers();
        const revoked = controllers.flatMap(controller =>
          controller.sessions.map(session => ({
            controllerId: controller.controllerId,
            sessionHandle: session.sessionHandle,
          }))
        );

        await writeControllers([]);

        return revoked;
      }),

    sessionOwner: sessionHandle =>
      runExclusive(async () => {
        const controllers = await readControllers();

        return controllers.find(controller =>
          controller.sessions.some(session => session.sessionHandle === sessionHandle)
        )?.controllerId;
      }),
  };
};
