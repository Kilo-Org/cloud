/* eslint-disable import/no-nodejs-modules, max-lines */
import type { BrowserContext, Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Default fixture data
// ---------------------------------------------------------------------------

const DEFAULT_ORG_ID = '11111111-1111-4111-8111-111111111111';

export const DEFAULT_CLOUD_SESSION: CloudAgentSessionSeed = {
  cloudAgentSessionId: 'agent_11111111-1111-4111-8111-111111111111',
  gitBranch: 'fix/login',
  gitUrl: 'github.com/org/repo',
  kiloSessionId: 'ses_cloudsession00000000001',
  mode: 'code',
  model: 'anthropic/claude-sonnet-4',
  status: 'running',
  title: 'Fix login bug',
};

export const DEFAULT_REMOTE_SESSION: RemoteSessionSeed = {
  gitBranch: 'main',
  gitUrl: 'github.com/org/repo',
  kiloSessionId: 'ses_remotesession00000000002',
  status: 'idle',
  title: 'Deploy to staging',
};

export const DEFAULT_HISTORY_SESSION_1: HistorySessionSeed = {
  sessionId: 'ses_historysession10000000001',
  title: 'Refactor auth module',
  updatedAt: new Date(Date.now() - 3_600_000).toISOString(),
};

export const DEFAULT_HISTORY_SESSION_2: HistorySessionSeed = {
  sessionId: 'ses_historysession20000000002',
  title: null,
  updatedAt: new Date(Date.now() - 86_400_000).toISOString(),
};

// ---------------------------------------------------------------------------
// Seed types
// ---------------------------------------------------------------------------

export interface CloudAgentSessionSeed {
  cloudAgentSessionId: string;
  gitBranch: string;
  gitUrl: string;
  kiloSessionId: string;
  mode: string;
  model: string;
  status: string;
  title: string;
}

export interface RemoteSessionSeed {
  gitBranch: string;
  gitUrl: string;
  kiloSessionId: string;
  status: string;
  title: string;
}

export interface HistorySessionSeed {
  sessionId: string;
  title: string | null;
  updatedAt: string;
}

export interface ConnectedInstanceSeed {
  connectionId: string;
  name: string;
  projectName: string;
}

export const DEFAULT_INSTANCE: ConnectedInstanceSeed = {
  connectionId: 'cli-connection-42',
  name: 'dev-laptop',
  projectName: 'checkout-service',
};

export const SPAWNED_SESSION_ID = 'ses_spawnedcli0000000000000001';

export interface AssociatedPrSeed {
  headSha: string | null;
  lastSyncedAt: string;
  number: number;
  /** Server always sends these two; keep the seed shape faithful. */
  reviewDecision: 'approved' | 'changes_requested' | 'review_required' | null;
  reviewDecisionPending: boolean;
  state: string;
  title: string | null;
  url: string;
}

export interface AgentsFixtureOptions {
  activeListFailuresBeforeSuccess?: number;
  activeSessions?: (CloudAgentSessionSeed | RemoteSessionSeed)[];
  cloudAgentWsEvents?: unknown[];
  /** PR returned on `cliSessionsV2.getWithRuntimeState` for cloud sessions. */
  cloudSessionAssociatedPr?: AssociatedPrSeed;
  getSessionFailuresBeforeSuccess?: number;
  historyListFailuresBeforeSuccess?: number;
  historySessions?: HistorySessionSeed[];
  /** Connected CLI instances returned by `activeSessions.listInstances`. */
  instances?: ConnectedInstanceSeed[];
  /** Keep the mocked ingest relay silent — the connection never reports
   * connected (simulates an outage; default false). */
  ingestSilent?: boolean;
  /** GitHub integration state for the repository pickers (default true). */
  integrationInstalled?: boolean;
  onCloudAgentClientMessage?: (message: unknown) => void;
  onIngestClientMessage?: (message: unknown) => void;
  prepareSessionError?: Record<string, unknown>;
  /** Fail `prepareSession` with 500 this many times, then succeed. */
  prepareSessionFailuresBeforeSuccess?: number;
  prepareSessionStatusCode?: number;
}

export interface AgentsFixtureResult {
  /** Every tRPC procedure dispatched through the mock (name + input). */
  calledProcedures: { input: unknown; proc: string }[];
  cloudAgentClientMessages: unknown[];
  ingestClientMessages: unknown[];
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

const isCloudAgentSessionSeed = (
  session: CloudAgentSessionSeed | RemoteSessionSeed
): session is CloudAgentSessionSeed => 'cloudAgentSessionId' in session;

const isRecordObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const hasStringOptional = (record: Record<string, unknown>, key: string): string | undefined =>
  typeof record[key] === 'string' ? record[key] : undefined;

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

const proceduresFromUrl = (url: string): string | null => {
  try {
    const { pathname } = new URL(url);
    const suffix = pathname.replace('/api/trpc/', '');
    if (suffix === '' || suffix.length === 0) {
      return null;
    }
    return suffix;
  } catch {
    return null;
  }
};

const parseTrpcInput = (url: string): unknown => {
  try {
    const parsed = new URL(url);
    const raw = parsed.searchParams.get('input');
    if (raw !== null && raw !== '') {
      return JSON.parse(raw) as unknown;
    }
    return undefined;
  } catch {
    return undefined;
  }
};

/**
 * Unwrap tRPC batch inputs from index-dictionary or array form.
 *
 * tRPC sends batch inputs as `{"0": input0, "1": input1}` (GET query param
 * and POST body).  Single-procedure calls send the input directly.
 */
const unwrapTrpcBatchInputs = (raw: unknown, count: number): unknown[] => {
  if (Array.isArray(raw)) {
    return raw;
  }
  if (isRecordObject(raw)) {
    const numericKeys = Object.keys(raw).filter(key => /^\d+$/.test(key));
    if (numericKeys.length > 0) {
      return Array.from({ length: count }, (_unused, idx) => raw[String(idx)]);
    }
  }
  return [raw];
};

// ---------------------------------------------------------------------------
// Mock builders
// ---------------------------------------------------------------------------

const activeSessionFromCloudAgent = (session: CloudAgentSessionSeed) => ({
  connectionId: 'cloud-agent',
  gitBranch: session.gitBranch,
  gitUrl: session.gitUrl,
  id: session.kiloSessionId,
  status: session.status,
  title: session.title,
});

const activeSessionFromRemote = (session: RemoteSessionSeed) => ({
  connectionId: 'cli-connection-1',
  gitBranch: session.gitBranch,
  gitUrl: session.gitUrl,
  id: session.kiloSessionId,
  status: session.status,
  title: session.title,
});

interface TrpcResultItem {
  error?: { data: { code: string; httpStatus: number }; message: string };
  result?: { data: unknown };
}

// ---------------------------------------------------------------------------
// JSON parse helper for WebSocket messages
// ---------------------------------------------------------------------------

const parseJsonMessage = (message: unknown): unknown => {
  const text = typeof message === 'string' ? message : String(message);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return message;
  }
};

// ---------------------------------------------------------------------------
// Main mock setup
// ---------------------------------------------------------------------------

export const mockAgentsApi = async (
  context: BrowserContext,
  options: AgentsFixtureOptions = {}
): Promise<AgentsFixtureResult> => {
  const activeSessions = options.activeSessions ?? [DEFAULT_CLOUD_SESSION, DEFAULT_REMOTE_SESSION];
  const historySessions = options.historySessions ?? [
    DEFAULT_HISTORY_SESSION_1,
    DEFAULT_HISTORY_SESSION_2,
  ];
  const cloudAgentClientMessages: unknown[] = [];
  const ingestClientMessages: unknown[] = [];
  const calledProcedures: { input: unknown; proc: string }[] = [];
  let activeListFailures = options.activeListFailuresBeforeSuccess ?? 0;
  let historyListFailures = options.historyListFailuresBeforeSuccess ?? 0;
  let getSessionFailures = options.getSessionFailuresBeforeSuccess ?? 0;
  let prepareSessionFailures = options.prepareSessionFailuresBeforeSuccess ?? 0;
  let preparedKiloSessionId: string | null = null;
  /** Set when a `create_session` command spawns a session on a CLI instance. */
  let spawnedKiloSessionId: string | null = null;

  // ---- /api/user ----
  await context.route('https://app.kilo.ai/api/user', route =>
    route.fulfill({ json: { google_user_email: 'user@kilo.ai' }, status: 200 })
  );

  // ---- /api/organizations ----
  await context.route('https://app.kilo.ai/api/organizations', route =>
    route.fulfill({
      json: { organizations: [{ id: DEFAULT_ORG_ID, name: 'Test Org' }] },
      status: 200,
    })
  );

  // ---- /api/gateway/models ----
  await context.route('https://app.kilo.ai/api/gateway/models', route =>
    route.fulfill({
      json: {
        data: [
          {
            id: 'anthropic/claude-sonnet-4',
            name: 'Anthropic: Claude Sonnet 4',
            opencode: { variants: { high: {}, low: {}, medium: {} } },
          },
        ],
      },
      status: 200,
    })
  );

  // ---- /api/cloud-agent-next/sessions/stream-ticket ----
  await context.route('https://app.kilo.ai/api/cloud-agent-next/sessions/stream-ticket', route =>
    route.fulfill({
      json: { expiresAt: Math.floor(Date.now() / 1000) + 3600, ticket: 'mock-stream-ticket' },
      status: 200,
    })
  );

  // ---- tRPC batch dispatcher ----
  const dispatchBatchProcedures = (procList: string[], inputs: unknown[]): TrpcResultItem[] =>
    procList.map((proc, index) => {
      const input = inputs[index];

      if (proc === 'activeSessions.list') {
        if (activeListFailures > 0) {
          activeListFailures -= 1;
          return {
            error: {
              data: { code: 'INTERNAL_SERVER_ERROR', httpStatus: 500 },
              message: 'Server error',
            },
          };
        }
        const sessions = activeSessions.map(session =>
          isCloudAgentSessionSeed(session)
            ? activeSessionFromCloudAgent(session)
            : activeSessionFromRemote(session)
        );
        if (spawnedKiloSessionId !== null) {
          sessions.push({
            connectionId: options.instances?.[0]?.connectionId ?? 'cli-connection-42',
            gitBranch: 'main',
            gitUrl: 'github.com/org/repo',
            id: spawnedKiloSessionId,
            status: 'idle',
            title: 'Spawned session',
          });
        }
        return { result: { data: { sessions } } };
      }

      if (proc === 'activeSessions.listInstances') {
        return { result: { data: { instances: options.instances ?? [] } } };
      }

      if (proc === 'cliSessionsV2.list') {
        if (historyListFailures > 0) {
          historyListFailures -= 1;
          return {
            error: {
              data: { code: 'INTERNAL_SERVER_ERROR', httpStatus: 500 },
              message: 'Server error',
            },
          };
        }
        return {
          result: {
            data: {
              cliSessions: historySessions.map(histSess => ({
                session_id: histSess.sessionId,
                title: histSess.title,
                updated_at: histSess.updatedAt,
              })),
              nextCursor: null,
            },
          },
        };
      }

      if (proc === 'cliSessionsV2.search') {
        const inputRecord = isRecordObject(input) ? input : {};
        const searchStr = hasStringOptional(inputRecord, 'search_string') ?? '';
        const term = searchStr.toLowerCase();
        const matching = historySessions.filter(
          histSess => histSess.title?.toLowerCase().includes(term) ?? false
        );
        return {
          result: {
            data: {
              results: matching.map(histSess => ({
                session_id: histSess.sessionId,
                title: histSess.title,
                updated_at: histSess.updatedAt,
              })),
            },
          },
        };
      }

      if (proc === 'cliSessionsV2.get' || proc === 'cliSessionsV2.getWithRuntimeState') {
        if (getSessionFailures > 0) {
          getSessionFailures -= 1;
          return {
            error: {
              data: { code: 'INTERNAL_SERVER_ERROR', httpStatus: 500 },
              message: 'Server error',
            },
          };
        }
        const inputRecord = isRecordObject(input) ? input : {};
        const requestedId = hasStringOptional(inputRecord, 'session_id') ?? '';

        // Prepared session always resolves with runtime state and
        // Cloud_agent_session_id so the UI treats it as interactive.
        if (requestedId === preparedKiloSessionId && requestedId !== '') {
          return {
            result: {
              data: {
                cloud_agent_session_id: 'agent_new0000000-0000-4000-8000-000000000001',
                git_branch: 'main',
                git_url: 'github.com/org/repo',
                organization_id: DEFAULT_ORG_ID,
                parent_session_id: null,
                runtimeState: {
                  githubRepo: 'github.com/org/repo',
                  initiatedAt: new Date().toISOString(),
                  mode: 'code',
                  model: 'anthropic/claude-sonnet-4',
                  preparedAt: new Date().toISOString(),
                  upstreamBranch: 'main',
                },
                session_id: requestedId,
                title: 'Test Session',
                total_cost_microdollars: 0,
              },
            },
          };
        }
        const cloudSession = activeSessions.find(
          (session): session is CloudAgentSessionSeed =>
            isCloudAgentSessionSeed(session) && session.kiloSessionId === requestedId
        );
        const runtimeState = cloudSession
          ? {
              githubRepo: cloudSession.gitUrl,
              initiatedAt: new Date().toISOString(),
              mode: cloudSession.mode,
              model: cloudSession.model,
              preparedAt: new Date().toISOString(),
              upstreamBranch: cloudSession.gitBranch,
            }
          : null;
        return {
          result: {
            data: {
              ...(cloudSession && options.cloudSessionAssociatedPr
                ? { associatedPr: options.cloudSessionAssociatedPr }
                : {}),
              cloud_agent_session_id: cloudSession?.cloudAgentSessionId ?? null,
              git_branch: cloudSession?.gitBranch ?? null,
              git_url: cloudSession?.gitUrl ?? null,
              organization_id: DEFAULT_ORG_ID,
              parent_session_id: null,
              runtimeState,
              session_id: requestedId,
              title:
                requestedId === spawnedKiloSessionId
                  ? 'Spawned session'
                  : (cloudSession?.title ?? 'Test Session'),
              total_cost_microdollars: 0,
            },
          },
        };
      }

      if (proc === 'cliSessionsV2.getSessionMessages') {
        return {
          result: {
            data: {
              info: { id: 'ses_cloudsession00000000001' },
              kiloSessionId: 'ses_cloudsession00000000001',
              messages: [],
            },
          },
        };
      }

      if (proc === 'cliSessionsV2.getSessionMessagesPage') {
        const inputRecord = isRecordObject(input) ? input : {};
        const requestedId =
          hasStringOptional(inputRecord, 'session_id') ?? 'ses_cloudsession00000000001';
        const cloudSession = activeSessions.find(
          (session): session is CloudAgentSessionSeed =>
            isCloudAgentSessionSeed(session) && session.kiloSessionId === requestedId
        );
        if (cloudSession !== undefined) {
          /**
           * A running cloud session's persisted page must carry its first
           * user message. The session manager retries an empty first page
           * while the session is still listed as running, and an
           * always-empty fixture page would keep the default cloud session
           * on its loading skeleton. The message and part ids match the
           * default stream's own user message, so the SDK upserts merge the
           * page and the live stream without duplicating transcript rows.
           */
          return {
            result: {
              data: {
                history: {
                  messages: [
                    {
                      info: {
                        agent: 'build',
                        id: 'msg-u-1',
                        model: { modelID: 'claude-sonnet-4', providerID: 'anthropic' },
                        role: 'user',
                        sessionID: requestedId,
                        time: { created: Date.now() },
                      },
                      parts: [
                        {
                          id: 'p-u-1',
                          messageID: 'msg-u-1',
                          sessionID: requestedId,
                          text: 'Fix the login bug',
                          type: 'text',
                        },
                      ],
                    },
                  ],
                  nextCursor: null,
                  omittedItemCount: 0,
                },
                kiloSessionId: requestedId,
              },
            },
          };
        }
        return {
          result: {
            data: {
              history: { messages: [], nextCursor: null, omittedItemCount: 0 },
              kiloSessionId: requestedId,
            },
          },
        };
      }

      if (proc === 'modelPreferences.get') {
        return { result: { data: { favorites: [], lastSelected: null } } };
      }

      if (proc === 'activeSessions.createWebTicket' || proc === 'activeSessions.getToken') {
        return {
          result: { data: { expiresAt: 1_700_000_000, token: 'mock-ingest-token' } },
        };
      }

      if (
        proc === 'cloudAgentNext.listGitHubRepositories' ||
        proc === 'organizations.cloudAgentNext.listGitHubRepositories'
      ) {
        const integrationInstalled = options.integrationInstalled ?? true;
        return {
          result: {
            data: {
              integrationInstalled,
              repositories: integrationInstalled
                ? [{ fullName: 'org/repo', id: 1, name: 'repo', private: false }]
                : [],
            },
          },
        };
      }

      // Generic success for unknown procedures
      return { result: { data: {} } };
    });

  // ---- tRPC route ----
  await context.route(
    url => {
      try {
        const { origin, pathname } = new URL(url);
        return origin === 'https://app.kilo.ai' && pathname.startsWith('/api/trpc');
      } catch {
        return false;
      }
    },
    async route => {
      const requestUrl = route.request().url();
      const method = route.request().method();
      const procListRaw = proceduresFromUrl(requestUrl);
      const procList = procListRaw === null ? [] : procListRaw.split(',');
      const isBatch = procList.length > 1;

      // Parse inputs: POST body dict/array or GET query param.
      let inputs: unknown[] = [];
      if (method === 'POST') {
        try {
          const body: unknown = route.request().postDataJSON();
          inputs = unwrapTrpcBatchInputs(body, procList.length);
        } catch {
          inputs = [];
        }
      } else {
        const raw = parseTrpcInput(requestUrl);
        inputs = unwrapTrpcBatchInputs(raw ?? {}, procList.length);
      }

      if (procList.length === 0) {
        await route.fulfill({ json: [], status: 200 });
        return;
      }

      // Single-procedure: handle mutations with skipBatch that need special status codes.
      if (!isBatch) {
        const proc = procList[0]!;

        if (
          proc === 'cloudAgentNext.prepareSession' ||
          proc === 'organizations.cloudAgentNext.prepareSession'
        ) {
          calledProcedures.push({ input: inputs[0], proc });
          if (prepareSessionFailures > 0) {
            prepareSessionFailures -= 1;
            await route.fulfill({
              json: {
                error: {
                  code: -32_603,
                  data: { code: 'INTERNAL_SERVER_ERROR', httpStatus: 500 },
                  message: 'Server error',
                },
              },
              status: 500,
            });
            return;
          }
          const statusCode = options.prepareSessionStatusCode;
          if (statusCode !== undefined) {
            const errorBody = options.prepareSessionError ?? {
              error: {
                code: -32_000,
                data: { code: 'PAYMENT_REQUIRED', httpStatus: 402 },
                message: 'Insufficient credits',
              },
            };
            await route.fulfill({ json: errorBody, status: statusCode });
            return;
          }
          preparedKiloSessionId = 'ses_newcloud0000000000001';
          await route.fulfill({
            json: {
              result: {
                data: {
                  cloudAgentSessionId: 'agent_new0000000-0000-4000-8000-000000000001',
                  kiloSessionId: 'ses_newcloud0000000000001',
                },
              },
            },
            status: 200,
          });
          return;
        }

        // Other skipBatch mutations — return generic success.
        const skipBatchMutations = [
          'cloudAgentNext.sendMessage',
          'organizations.cloudAgentNext.sendMessage',
          'cloudAgentNext.interruptSession',
          'organizations.cloudAgentNext.interruptSession',
          'cloudAgentNext.answerQuestion',
          'organizations.cloudAgentNext.answerQuestion',
          'cloudAgentNext.rejectQuestion',
          'organizations.cloudAgentNext.rejectQuestion',
          'cloudAgentNext.answerPermission',
          'organizations.cloudAgentNext.answerPermission',
          'modelPreferences.setLastSelected',
        ];
        if (skipBatchMutations.includes(proc)) {
          calledProcedures.push({ input: inputs[0], proc });
          await route.fulfill({ json: { result: { data: {} } }, status: 200 });
          return;
        }
      }

      // Dispatch through the batch handler (works for single items too).
      const results = dispatchBatchProcedures(procList, inputs);
      for (let idx = 0; idx < procList.length; idx++) {
        calledProcedures.push({ input: inputs[idx]!, proc: procList[idx]! });
      }
      await route.fulfill({ json: isBatch ? results : results[0], status: 200 });
    }
  );

  // ---- WebSocket: cloud-agent-next ----
  await context.routeWebSocket('wss://cloud-agent-next.kilosessions.ai/*', ws => {
    ws.onMessage(message => {
      const parsed = parseJsonMessage(message);
      cloudAgentClientMessages.push(parsed);
      options.onCloudAgentClientMessage?.(parsed);
    });
    const events = options.cloudAgentWsEvents ?? buildDefaultCloudAgentStream();
    for (const event of events) {
      ws.send(JSON.stringify(event));
    }
  });

  // ---- WebSocket: session ingest ----
  // Glob with a wildcard — the client appends ?token=…&connectionId=… and a
  // Bare-string pattern silently never matches (auth then fails).
  await context.routeWebSocket('wss://ingest.kilosessions.ai/api/user/web**', ws => {
    // A healthy relay speaks first; one parsed message marks the SDK
    // Connection as connected. `ingestSilent` simulates an outage instead.
    if (options.ingestSilent !== true) {
      ws.send(JSON.stringify({ data: {}, event: 'connected', type: 'system' }));
    }
    ws.onMessage(message => {
      const parsed = parseJsonMessage(message);
      ingestClientMessages.push(parsed);
      options.onIngestClientMessage?.(parsed);
      if (isRecordObject(parsed) && parsed['type'] === 'ping') {
        // Answer liveness pings so the SDK keeps the socket alive.
        if (options.ingestSilent !== true) {
          ws.send(JSON.stringify({ nonce: parsed['nonce'], type: 'pong' }));
        }
        return;
      }
      if (
        isRecordObject(parsed) &&
        typeof parsed['type'] === 'string' &&
        parsed['type'] === 'command'
      ) {
        const cmdId = typeof parsed['id'] === 'string' ? parsed['id'] : '';
        // Spawn commands answer with the strict v1 envelope so the
        // Extension's CLI spawn flow can navigate to the new session.
        if (parsed['command'] === 'create_session') {
          spawnedKiloSessionId = SPAWNED_SESSION_ID;
          ws.send(
            JSON.stringify({
              id: cmdId,
              result: { protocolVersion: 1, sessionID: SPAWNED_SESSION_ID },
              type: 'response',
            })
          );
          return;
        }
        ws.send(JSON.stringify({ id: cmdId, result: {}, type: 'response' }));
      }
    });
  });

  return { calledProcedures, cloudAgentClientMessages, ingestClientMessages };
};

// ---------------------------------------------------------------------------
// Cloud Agent WebSocket event builders
// ---------------------------------------------------------------------------

let _eventCounter = 0;

/**
 * A fenced code block of exactly 20 lines: more than COLLAPSE_LINE_THRESHOLD
 * (15), matching the "Show more (20 lines)" label the shared code block
 * already asserts.
 */
const longCodeBlock = (): string => {
  const lines = Array.from({ length: 20 }, (_unused, index) => `line ${index + 1}`);
  return `\`\`\`ts\n${lines.join('\n')}\n\`\`\``;
};

const buildDefaultCloudAgentStream = (): Record<string, unknown>[] => {
  _eventCounter = 0;
  const sessionId = 'ses_cloudsession00000000001';

  const ev = (streamEventType: string, eventData: unknown): Record<string, unknown> => ({
    data: eventData,
    eventId: ++_eventCounter,
    executionId: 'exec-stream-1',
    sessionId,
    streamEventType,
    timestamp: new Date().toISOString(),
  });

  const kilocode = (type: string, properties: unknown): Record<string, unknown> =>
    ev('kilocode', { properties, type });

  const assistantText = `I found the issue.\n\n${longCodeBlock()}`;

  return [
    kilocode('session.created', { info: { id: sessionId } }),
    kilocode('session.status', { sessionID: sessionId, status: { type: 'busy' } }),
    kilocode('message.updated', {
      info: {
        agent: 'build',
        id: 'msg-u-1',
        model: { modelID: 'claude-sonnet-4', providerID: 'anthropic' },
        role: 'user',
        sessionID: sessionId,
        time: { created: Date.now() },
      },
    }),
    kilocode('message.part.updated', {
      part: {
        id: 'p-u-1',
        messageID: 'msg-u-1',
        sessionID: sessionId,
        text: 'Fix the login bug',
        type: 'text',
      },
    }),
    kilocode('message.updated', {
      info: {
        agent: 'build',
        cost: 0,
        id: 'msg-a-1',
        mode: 'code',
        modelID: 'claude-sonnet-4',
        parentID: 'msg-u-1',
        path: { cwd: '/', root: '/' },
        providerID: 'anthropic',
        role: 'assistant',
        sessionID: sessionId,
        time: { created: Date.now() },
        tokens: { cache: { read: 0, write: 0 }, input: 0, output: 0, reasoning: 0 },
      },
    }),
    kilocode('message.part.delta', {
      delta: 'I found the issue.',
      field: 'text',
      messageID: 'msg-a-1',
      partID: 'p-a-1',
      sessionID: sessionId,
    }),
    kilocode('message.part.delta', {
      delta: `\n\n${longCodeBlock()}`,
      field: 'text',
      messageID: 'msg-a-1',
      partID: 'p-a-1',
      sessionID: sessionId,
    }),
    // Synthetic snapshot progress — the adapter must never render this.
    kilocode('message.part.updated', {
      part: {
        id: 'p-a-snap',
        messageID: 'msg-a-1',
        sessionID: sessionId,
        synthetic: true,
        text: '⠋ Initializing snapshot…',
        type: 'text',
      },
    }),
    kilocode('message.part.updated', {
      part: {
        id: 'p-a-think',
        messageID: 'msg-a-1',
        sessionID: sessionId,
        text: 'Checking the auth guard first.',
        time: { start: Date.now() },
        type: 'reasoning',
      },
    }),
    kilocode('message.part.updated', {
      part: {
        callID: 'call-1',
        id: 'p-a-tool',
        messageID: 'msg-a-1',
        sessionID: sessionId,
        state: {
          input: { filePath: 'src/auth.ts' },
          metadata: {},
          output: 'export const guard = () => true;',
          status: 'completed',
          time: { end: Date.now(), start: Date.now() },
          title: 'src/auth.ts',
        },
        tool: 'read',
        type: 'tool',
      },
    }),
    // A screenshot tool carrying a real PNG attachment exercises the whole
    // Image chain: the SDK onToolAttachment sink, the bounded store, the
    // Adapter lookup, and the shared renderer <img> branch.
    kilocode('message.part.updated', {
      part: {
        callID: 'call-2',
        id: 'p-a-shot',
        messageID: 'msg-a-1',
        sessionID: sessionId,
        state: {
          attachments: [
            {
              id: 'att-1',
              messageID: 'msg-a-1',
              mime: 'image/png',
              sessionID: sessionId,
              type: 'file',
              url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
            },
          ],
          input: { fullPage: false },
          metadata: {},
          output: 'captured',
          status: 'completed',
          time: { end: Date.now(), start: Date.now() },
          title: 'viewport',
        },
        tool: 'browser_screenshot',
        type: 'tool',
      },
    }),
    kilocode('message.part.updated', {
      part: {
        id: 'p-a-1',
        messageID: 'msg-a-1',
        sessionID: sessionId,
        text: assistantText,
        type: 'text',
      },
    }),
    // Finalize the assistant message. Without time.completed the adapter keeps
    // Treating it as streaming, force-expands the code block, and the shared
    // Component never renders its "Show more" control.
    kilocode('message.updated', {
      info: {
        agent: 'build',
        cost: 0,
        id: 'msg-a-1',
        mode: 'code',
        modelID: 'claude-sonnet-4',
        parentID: 'msg-u-1',
        path: { cwd: '/', root: '/' },
        providerID: 'anthropic',
        role: 'assistant',
        sessionID: sessionId,
        time: { completed: Date.now(), created: Date.now() },
        tokens: { cache: { read: 0, write: 0 }, input: 0, output: 0, reasoning: 0 },
      },
    }),
    ev('complete', { currentBranch: 'main' }),
  ];
};

/**
 * Build a cloud-agent stream that stays running (no `complete` event) so the
 * Stop button remains visible for interrupt testing.
 */
export const buildRunningCloudAgentStream = (
  sessionId = 'ses_cloudsession00000000001'
): Record<string, unknown>[] => {
  _eventCounter = 0;
  const ev = (streamEventType: string, eventData: unknown): Record<string, unknown> => ({
    data: eventData,
    eventId: ++_eventCounter,
    executionId: 'exec-stream-1',
    sessionId,
    streamEventType,
    timestamp: new Date().toISOString(),
  });

  const kilocode = (type: string, properties: unknown): Record<string, unknown> =>
    ev('kilocode', { properties, type });

  return [
    kilocode('session.created', { info: { id: sessionId } }),
    kilocode('session.status', { sessionID: sessionId, status: { type: 'busy' } }),
    kilocode('message.updated', {
      info: {
        agent: 'build',
        id: 'msg-u-run',
        model: { modelID: 'claude-sonnet-4', providerID: 'anthropic' },
        role: 'user',
        sessionID: sessionId,
        time: { created: Date.now() },
      },
    }),
    kilocode('message.part.updated', {
      part: {
        id: 'p-u-run',
        messageID: 'msg-u-run',
        sessionID: sessionId,
        text: 'Long running task',
        type: 'text',
      },
    }),
  ];
};

export const buildQuestionCloudAgentStream = (
  sessionId = 'ses_cloudsession00000000001'
): Record<string, unknown>[] => {
  _eventCounter = 0;
  const ev = (streamEventType: string, eventData: unknown): Record<string, unknown> => ({
    data: eventData,
    eventId: ++_eventCounter,
    executionId: 'exec-stream-q',
    sessionId,
    streamEventType,
    timestamp: new Date().toISOString(),
  });

  const kilocode = (type: string, properties: unknown): Record<string, unknown> =>
    ev('kilocode', { properties, type });

  return [
    kilocode('session.created', { info: { id: sessionId } }),
    kilocode('session.status', { sessionID: sessionId, status: { type: 'question' } }),
    kilocode('message.updated', {
      info: {
        agent: 'build',
        id: 'msg-u-q',
        model: { modelID: 'claude-sonnet-4', providerID: 'anthropic' },
        role: 'user',
        sessionID: sessionId,
        time: { created: Date.now() },
      },
    }),
    kilocode('message.part.updated', {
      part: {
        id: 'p-u-q',
        messageID: 'msg-u-q',
        sessionID: sessionId,
        text: 'Deploy the app',
        type: 'text',
      },
    }),
    ev('question.asked', {
      callID: 'call-q-1',
      id: 'q-1',
      questions: [
        {
          header: 'Deployment target',
          options: [
            { description: 'Deploy to staging', label: 'Staging' },
            { description: 'Deploy to production', label: 'Production' },
          ],
          question: 'Which environment?',
        },
      ],
    }),
    ev('session.status', { sessionID: sessionId, status: { type: 'question' } }),
  ];
};

export const buildPermissionCloudAgentStream = (
  sessionId = 'ses_cloudsession00000000001'
): Record<string, unknown>[] => {
  _eventCounter = 0;
  const ev = (streamEventType: string, eventData: unknown): Record<string, unknown> => ({
    data: eventData,
    eventId: ++_eventCounter,
    executionId: 'exec-stream-p',
    sessionId,
    streamEventType,
    timestamp: new Date().toISOString(),
  });

  const kilocode = (type: string, properties: unknown): Record<string, unknown> =>
    ev('kilocode', { properties, type });

  return [
    kilocode('session.created', { info: { id: sessionId } }),
    kilocode('session.status', { sessionID: sessionId, status: { type: 'permission' } }),
    kilocode('message.updated', {
      info: {
        agent: 'build',
        id: 'msg-u-p',
        model: { modelID: 'claude-sonnet-4', providerID: 'anthropic' },
        role: 'user',
        sessionID: sessionId,
        time: { created: Date.now() },
      },
    }),
    kilocode('message.part.updated', {
      part: {
        id: 'p-u-p',
        messageID: 'msg-u-p',
        sessionID: sessionId,
        text: 'Read the env file',
        type: 'text',
      },
    }),
    ev('permission.asked', {
      always: [],
      callID: 'call-p-1',
      id: 'perm-1',
      metadata: {},
      patterns: ['/app/.env.production', '/app/.env.*'],
      permission: 'read /app/.env.production',
    }),
    ev('session.status', { sessionID: sessionId, status: { type: 'permission' } }),
  ];
};

// ---------------------------------------------------------------------------
// Live-test helpers
// ---------------------------------------------------------------------------

export const navigateToAgentsMode = async (sidePanel: Page): Promise<void> => {
  const agentsTab = sidePanel.getByRole('tab', { name: 'Agents' });
  await agentsTab.click();
  await sidePanel
    .getByRole('button', { exact: true, name: 'New session' })
    .waitFor({ state: 'visible', timeout: 15_000 });
  await sidePanel.waitForTimeout(500);
};
