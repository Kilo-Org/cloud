/* eslint-disable import/no-nodejs-modules, max-lines */
import type { BrowserContext, Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Default fixture data
// ---------------------------------------------------------------------------

const DEFAULT_ORG_ID = '11111111-1111-4111-8111-111111111111';

export const DEFAULT_CLOUD_SESSION: CloudAgentSessionSeed = {
  kiloSessionId: 'ses_cloudsession00000000001',
  cloudAgentSessionId: 'agent_11111111-1111-4111-8111-111111111111',
  title: 'Fix login bug',
  status: 'running',
  gitUrl: 'github.com/org/repo',
  gitBranch: 'fix/login',
  mode: 'code',
  model: 'anthropic/claude-sonnet-4',
};

export const DEFAULT_REMOTE_SESSION: RemoteSessionSeed = {
  kiloSessionId: 'ses_remotesession00000000002',
  title: 'Deploy to staging',
  status: 'idle',
  gitUrl: 'github.com/org/repo',
  gitBranch: 'main',
};

export const DEFAULT_HISTORY_SESSION_1: HistorySessionSeed = {
  sessionId: 'ses_historysession10000000001',
  title: 'Refactor auth module',
  updatedAt: new Date(Date.now() - 3600_000).toISOString(),
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
  kiloSessionId: string;
  cloudAgentSessionId: string;
  title: string;
  status: string;
  gitUrl: string;
  gitBranch: string;
  mode: string;
  model: string;
}

export interface RemoteSessionSeed {
  kiloSessionId: string;
  title: string;
  status: string;
  gitUrl: string;
  gitBranch: string;
}

export interface HistorySessionSeed {
  sessionId: string;
  title: string | null;
  updatedAt: string;
}

export interface AgentsFixtureOptions {
  activeSessions?: (CloudAgentSessionSeed | RemoteSessionSeed)[];
  historySessions?: HistorySessionSeed[];
  activeListFailuresBeforeSuccess?: number;
  historyListFailuresBeforeSuccess?: number;
  getSessionFailuresBeforeSuccess?: number;
  prepareSessionStatusCode?: number;
  prepareSessionError?: Record<string, unknown>;
  cloudAgentWsEvents?: unknown[];
  onCloudAgentClientMessage?: (message: unknown) => void;
  onIngestClientMessage?: (message: unknown) => void;
}

export interface AgentsFixtureResult {
  cloudAgentClientMessages: unknown[];
  ingestClientMessages: unknown[];
  /** Every tRPC procedure dispatched through the mock (name + input). */
  calledProcedures: { proc: string; input: unknown }[];
}

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

const proceduresFromUrl = (url: string): string | null => {
  try {
    const { pathname } = new URL(url);
    const suffix = pathname.replace('/api/trpc/', '');
    if (!suffix || suffix === '') return null;
    return suffix;
  } catch {
    return null;
  }
};

const parseTrpcInput = (url: string): unknown => {
  try {
    const parsed = new URL(url);
    const raw = parsed.searchParams.get('input');
    if (raw) return JSON.parse(raw);
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
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const dict = raw as Record<string, unknown>;
    const numericKeys = Object.keys(dict).filter(key => /^\d+$/.test(key));
    if (numericKeys.length > 0) {
      return Array.from({ length: count }, (_unused, idx) => dict[String(idx)]);
    }
  }
  return [raw];
};

// ---------------------------------------------------------------------------
// Mock builders
// ---------------------------------------------------------------------------

const activeSessionFromCloudAgent = (s: CloudAgentSessionSeed) => ({
  id: s.kiloSessionId,
  title: s.title,
  status: s.status,
  gitUrl: s.gitUrl,
  gitBranch: s.gitBranch,
  connectionId: 'cloud-agent',
});

const activeSessionFromRemote = (s: RemoteSessionSeed) => ({
  id: s.kiloSessionId,
  title: s.title,
  status: s.status,
  gitUrl: s.gitUrl,
  gitBranch: s.gitBranch,
  connectionId: 'cli-connection-1',
});

type TrpcResultItem = {
  result?: { data: unknown };
  error?: { message: string; data: { code: string; httpStatus: number } };
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
  const calledProcedures: { proc: string; input: unknown }[] = [];
  let activeListFailures = options.activeListFailuresBeforeSuccess ?? 0;
  let historyListFailures = options.historyListFailuresBeforeSuccess ?? 0;
  let getSessionFailures = options.getSessionFailuresBeforeSuccess ?? 0;
  let preparedKiloSessionId: string | null = null;

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
    route.fulfill({ json: { ticket: 'mock-stream-ticket' }, status: 200 })
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
              message: 'Server error',
              data: { code: 'INTERNAL_SERVER_ERROR', httpStatus: 500 },
            },
          };
        }
        const sessions = activeSessions.map(s =>
          'cloudAgentSessionId' in s ? activeSessionFromCloudAgent(s) : activeSessionFromRemote(s)
        );
        return { result: { data: { sessions } } };
      }

      if (proc === 'cliSessionsV2.list') {
        if (historyListFailures > 0) {
          historyListFailures -= 1;
          return {
            error: {
              message: 'Server error',
              data: { code: 'INTERNAL_SERVER_ERROR', httpStatus: 500 },
            },
          };
        }
        return {
          result: {
            data: {
              cliSessions: historySessions.map(s => ({
                session_id: s.sessionId,
                title: s.title,
                updated_at: s.updatedAt,
              })),
              nextCursor: null,
            },
          },
        };
      }

      if (proc === 'cliSessionsV2.search') {
        const searchStr =
          typeof (input as Record<string, unknown> | undefined)?.['search_string'] === 'string'
            ? ((input as Record<string, unknown>)['search_string'] as string).toLowerCase()
            : '';
        const matching = historySessions.filter(
          s => s.title?.toLowerCase().includes(searchStr) ?? false
        );
        return {
          result: {
            data: {
              results: matching.map(s => ({
                session_id: s.sessionId,
                title: s.title,
                updated_at: s.updatedAt,
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
              message: 'Server error',
              data: { code: 'INTERNAL_SERVER_ERROR', httpStatus: 500 },
            },
          };
        }
        const requestedId =
          typeof (input as Record<string, unknown> | undefined)?.['session_id'] === 'string'
            ? (input as Record<string, unknown>)['session_id']
            : '';

        // Prepared session always resolves with runtime state and
        // cloud_agent_session_id so the UI treats it as interactive.
        if (requestedId === preparedKiloSessionId && requestedId !== '') {
          return {
            result: {
              data: {
                session_id: requestedId,
                cloud_agent_session_id: 'agent_new0000000-0000-4000-8000-000000000001',
                title: 'Test Session',
                organization_id: DEFAULT_ORG_ID,
                git_url: 'github.com/org/repo',
                git_branch: 'main',
                parent_session_id: null,
                runtimeState: {
                  mode: 'code',
                  model: 'anthropic/claude-sonnet-4',
                  githubRepo: 'github.com/org/repo',
                  upstreamBranch: 'main',
                  initiatedAt: new Date().toISOString(),
                  preparedAt: new Date().toISOString(),
                },
                total_cost_microdollars: 0,
              },
            },
          };
        }
        const cloudSession = activeSessions.find(
          s => 'cloudAgentSessionId' in s && s.kiloSessionId === requestedId
        ) as CloudAgentSessionSeed | undefined;
        const runtimeState = cloudSession
          ? {
              mode: cloudSession.mode,
              model: cloudSession.model,
              githubRepo: cloudSession.gitUrl,
              upstreamBranch: cloudSession.gitBranch,
              initiatedAt: new Date().toISOString(),
              preparedAt: new Date().toISOString(),
            }
          : null;
        return {
          result: {
            data: {
              session_id: requestedId,
              ...(cloudSession ? { cloud_agent_session_id: cloudSession.cloudAgentSessionId } : {}),
              title: cloudSession?.title ?? 'Test Session',
              organization_id: DEFAULT_ORG_ID,
              git_url: cloudSession?.gitUrl ?? null,
              git_branch: cloudSession?.gitBranch ?? null,
              parent_session_id: null,
              runtimeState,
              total_cost_microdollars: 0,
            },
          },
        };
      }

      if (proc === 'cliSessionsV2.getSessionMessages') {
        return {
          result: {
            data: {
              kiloSessionId: 'ses_cloudsession00000000001',
              info: { id: 'ses_cloudsession00000000001' },
              messages: [],
            },
          },
        };
      }

      if (proc === 'cliSessionsV2.getSessionMessagesPage') {
        return {
          result: {
            data: {
              kiloSessionId: 'ses_cloudsession00000000001',
              history: { messages: [], nextCursor: null, omittedItemCount: 0 },
            },
          },
        };
      }

      if (proc === 'modelPreferences.get') {
        return { result: { data: { favorites: [], lastSelected: null } } };
      }

      if (proc === 'activeSessions.getToken') {
        return { result: { data: { token: 'mock-ingest-token' } } };
      }

      if (
        proc === 'cloudAgentNext.listGitHubRepositories' ||
        proc === 'organizations.cloudAgentNext.listGitHubRepositories'
      ) {
        return {
          result: {
            data: {
              repositories: [{ id: 1, name: 'repo', fullName: 'org/repo', private: false }],
              integrationInstalled: true,
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
      const procList = procListRaw ? procListRaw.split(',') : [];
      const isBatch = procList.length > 1;

      // Parse inputs: POST body dict/array or GET query param.
      let inputs: unknown[] = [];
      if (method === 'POST') {
        try {
          const body = route.request().postDataJSON();
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
          const statusCode = options.prepareSessionStatusCode;
          if (statusCode !== undefined) {
            const errorBody = options.prepareSessionError ?? {
              error: {
                message: 'Insufficient credits',
                code: -32000,
                data: { code: 'PAYMENT_REQUIRED', httpStatus: 402 },
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
      try {
        const parsed = JSON.parse(typeof message === 'string' ? message : message.toString());
        cloudAgentClientMessages.push(parsed);
        options.onCloudAgentClientMessage?.(parsed);
      } catch {
        cloudAgentClientMessages.push(message);
      }
    });
    const events = options.cloudAgentWsEvents ?? buildDefaultCloudAgentStream();
    for (const event of events) {
      ws.send(JSON.stringify(event));
    }
  });

  // ---- WebSocket: session ingest ----
  await context.routeWebSocket('wss://ingest.kilosessions.ai/api/user/web', ws => {
    ws.onMessage(message => {
      try {
        const parsed = JSON.parse(typeof message === 'string' ? message : message.toString());
        ingestClientMessages.push(parsed);
        options.onIngestClientMessage?.(parsed);
        if (
          parsed &&
          typeof parsed === 'object' &&
          (parsed as Record<string, unknown>)['type'] === 'command'
        ) {
          const cmd = parsed as { type: string; id: string; command: string };
          ws.send(JSON.stringify({ type: 'response', id: cmd.id, result: {} }));
        }
      } catch {
        ingestClientMessages.push(message);
      }
    });
  });

  return { cloudAgentClientMessages, ingestClientMessages, calledProcedures };
};

// ---------------------------------------------------------------------------
// Cloud Agent WebSocket event builders
// ---------------------------------------------------------------------------

let _eventCounter = 0;

const buildDefaultCloudAgentStream = (): Record<string, unknown>[] => {
  _eventCounter = 0;
  const sessionId = 'ses_cloudsession00000000001';

  const ev = (streamEventType: string, data: unknown): Record<string, unknown> => ({
    eventId: ++_eventCounter,
    executionId: 'exec-stream-1',
    sessionId,
    streamEventType,
    timestamp: new Date().toISOString(),
    data,
  });

  const kilocode = (type: string, properties: unknown): Record<string, unknown> =>
    ev('kilocode', { type, properties });

  return [
    kilocode('session.created', { info: { id: sessionId } }),
    kilocode('session.status', { sessionID: sessionId, status: { type: 'busy' } }),
    kilocode('message.updated', {
      info: {
        id: 'msg-u-1',
        sessionID: sessionId,
        role: 'user',
        time: { created: Date.now() },
        agent: 'build',
        model: { providerID: 'anthropic', modelID: 'claude-sonnet-4' },
      },
    }),
    kilocode('message.part.updated', {
      part: {
        id: 'p-u-1',
        sessionID: sessionId,
        messageID: 'msg-u-1',
        type: 'text',
        text: 'Fix the login bug',
      },
    }),
    kilocode('message.updated', {
      info: {
        id: 'msg-a-1',
        sessionID: sessionId,
        role: 'assistant',
        time: { created: Date.now() },
        parentID: 'msg-u-1',
        modelID: 'claude-sonnet-4',
        providerID: 'anthropic',
        mode: 'code',
        agent: 'build',
        path: { cwd: '/', root: '/' },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    }),
    kilocode('message.part.delta', {
      sessionID: sessionId,
      messageID: 'msg-a-1',
      partID: 'p-a-1',
      field: 'text',
      delta: 'I found',
    }),
    kilocode('message.part.delta', {
      sessionID: sessionId,
      messageID: 'msg-a-1',
      partID: 'p-a-1',
      field: 'text',
      delta: ' the issue.',
    }),
    kilocode('message.part.updated', {
      part: {
        id: 'p-a-1',
        sessionID: sessionId,
        messageID: 'msg-a-1',
        type: 'text',
        text: 'I found the issue.',
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
  const ev = (streamEventType: string, data: unknown): Record<string, unknown> => ({
    eventId: ++_eventCounter,
    executionId: 'exec-stream-1',
    sessionId,
    streamEventType,
    timestamp: new Date().toISOString(),
    data,
  });

  const kilocode = (type: string, properties: unknown): Record<string, unknown> =>
    ev('kilocode', { type, properties });

  return [
    kilocode('session.created', { info: { id: sessionId } }),
    kilocode('session.status', { sessionID: sessionId, status: { type: 'busy' } }),
    kilocode('message.updated', {
      info: {
        id: 'msg-u-run',
        sessionID: sessionId,
        role: 'user',
        time: { created: Date.now() },
        agent: 'build',
        model: { providerID: 'anthropic', modelID: 'claude-sonnet-4' },
      },
    }),
    kilocode('message.part.updated', {
      part: {
        id: 'p-u-run',
        sessionID: sessionId,
        messageID: 'msg-u-run',
        type: 'text',
        text: 'Long running task',
      },
    }),
  ];
};

export const buildQuestionCloudAgentStream = (
  sessionId = 'ses_cloudsession00000000001'
): Record<string, unknown>[] => {
  _eventCounter = 0;
  const ev = (streamEventType: string, data: unknown): Record<string, unknown> => ({
    eventId: ++_eventCounter,
    executionId: 'exec-stream-q',
    sessionId,
    streamEventType,
    timestamp: new Date().toISOString(),
    data,
  });

  const kilocode = (type: string, properties: unknown): Record<string, unknown> =>
    ev('kilocode', { type, properties });

  return [
    kilocode('session.created', { info: { id: sessionId } }),
    kilocode('session.status', { sessionID: sessionId, status: { type: 'question' } }),
    kilocode('message.updated', {
      info: {
        id: 'msg-u-q',
        sessionID: sessionId,
        role: 'user',
        time: { created: Date.now() },
        agent: 'build',
        model: { providerID: 'anthropic', modelID: 'claude-sonnet-4' },
      },
    }),
    kilocode('message.part.updated', {
      part: {
        id: 'p-u-q',
        sessionID: sessionId,
        messageID: 'msg-u-q',
        type: 'text',
        text: 'Deploy the app',
      },
    }),
    ev('question.asked', {
      id: 'q-1',
      callID: 'call-q-1',
      questions: [
        {
          header: 'Deployment target',
          question: 'Which environment?',
          options: [
            { label: 'Staging', description: 'Deploy to staging' },
            { label: 'Production', description: 'Deploy to production' },
          ],
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
  const ev = (streamEventType: string, data: unknown): Record<string, unknown> => ({
    eventId: ++_eventCounter,
    executionId: 'exec-stream-p',
    sessionId,
    streamEventType,
    timestamp: new Date().toISOString(),
    data,
  });

  const kilocode = (type: string, properties: unknown): Record<string, unknown> =>
    ev('kilocode', { type, properties });

  return [
    kilocode('session.created', { info: { id: sessionId } }),
    kilocode('session.status', { sessionID: sessionId, status: { type: 'permission' } }),
    kilocode('message.updated', {
      info: {
        id: 'msg-u-p',
        sessionID: sessionId,
        role: 'user',
        time: { created: Date.now() },
        agent: 'build',
        model: { providerID: 'anthropic', modelID: 'claude-sonnet-4' },
      },
    }),
    kilocode('message.part.updated', {
      part: {
        id: 'p-u-p',
        sessionID: sessionId,
        messageID: 'msg-u-p',
        type: 'text',
        text: 'Read the env file',
      },
    }),
    ev('permission.asked', {
      id: 'perm-1',
      callID: 'call-p-1',
      permission: 'read /app/.env.production',
      patterns: ['/app/.env.production', '/app/.env.*'],
      metadata: {},
      always: [],
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
    .getByRole('button', { name: 'New session', exact: true })
    .waitFor({ state: 'visible', timeout: 15_000 });
  await sidePanel.waitForTimeout(500);
};
