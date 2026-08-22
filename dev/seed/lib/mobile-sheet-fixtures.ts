// Pure fixture builders and status parsing for the mobile sheet transcript
// seed. This module has no database or network side effects: the node test
// imports it without a live stack.

export const ROOT_SESSION_ID = 'ses_000000000001RootFixture001';
export const CHILD_SESSION_ID = 'ses_000000000002ChildFixture01';

export const ROOT_SESSION_TITLE = 'Mobile sheet fixtures';
export const CHILD_SESSION_TITLE = 'Inspect child fixture';
export const ROOT_SESSION_SLUG = 'mobile-sheet-fixtures';
export const CHILD_SESSION_SLUG = 'inspect-child-fixture';

export const FIXTURE_PROJECT_ID = 'fixture';
export const FIXTURE_DIRECTORY = '/workspace';
export const FIXTURE_SESSION_VERSION = '1';

export const MODEL_PROVIDER_ID = 'kilo';
export const MODEL_ID = 'anthropic/claude-sonnet-4';
export const FIXTURE_AGENT = 'build';
export const FIXTURE_MODE = 'code';

export const ROOT_USER_MESSAGE_ID = 'msgRootUser00000001';
export const ROOT_ASSISTANT_MESSAGE_ID = 'msgRootAssistant001';
export const ROOT_READ_PART_ID = 'prtRootRead00000001';
export const ROOT_TASK_PART_ID = 'prtRootTask00000001';
export const ROOT_FILE_PART_ID = 'prtRootFile00000001';

export const CHILD_USER_MESSAGE_ID = 'msgChildUser0000001';
export const CHILD_ASSISTANT_MESSAGE_ID = 'msgChildAssistant01';
export const CHILD_BASH_PART_ID = 'prtChildBash0000001';

export const FIXTURE_TIME_CREATED = 1_700_000_000_000;
export const FIXTURE_TIME_UPDATED = 1_700_000_300_000;

const ROOT_USER_CREATED = 1_700_000_010_000;
const ROOT_ASSISTANT_CREATED = 1_700_000_020_000;
const ROOT_ASSISTANT_COMPLETED = 1_700_000_025_000;
const ROOT_READ_START = 1_700_000_021_000;
const ROOT_READ_END = 1_700_000_022_000;
const ROOT_TASK_START = 1_700_000_022_500;
const ROOT_TASK_END = 1_700_000_024_000;

const CHILD_USER_CREATED = 1_700_000_040_000;
const CHILD_ASSISTANT_CREATED = 1_700_000_050_000;
const CHILD_ASSISTANT_COMPLETED = 1_700_000_055_000;
const CHILD_BASH_START = 1_700_000_051_000;
const CHILD_BASH_END = 1_700_000_054_000;

const ROOT_FILE_MIME = 'text/plain';
const ROOT_FILE_NAME = 'fixture-notes.txt';
const ROOT_FILE_URL = 'data:text/plain;base64,Zml4dHVyZSBub3RlcyBjb250ZW50';

export const SESSION_INGEST_SERVICE_NAME = 'cloudflare-session-ingest';

export type FixtureTokens = {
  total: number;
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
};

export type SessionIngestItem = {
  type: 'session' | 'message' | 'part';
  data: Record<string, unknown>;
};

export type SessionIngestServiceStatus = {
  name: string;
  status: 'up' | 'down';
  port: number;
};

const ROOT_ASSISTANT_COST = 0.01;
const ROOT_ASSISTANT_TOKENS: FixtureTokens = {
  total: 1375,
  input: 1000,
  output: 200,
  reasoning: 100,
  cache: { read: 50, write: 25 },
};

const CHILD_ASSISTANT_COST = 0.02;
const CHILD_ASSISTANT_TOKENS: FixtureTokens = {
  total: 500,
  input: 400,
  output: 60,
  reasoning: 30,
  cache: { read: 5, write: 5 },
};

/** The exact session IDs this seed resets. Nothing else is touched. */
export function fixtureSessionIds(): string[] {
  return [ROOT_SESSION_ID, CHILD_SESSION_ID];
}

/** Part IDs that must appear in the materialized history for a fixture session. */
export function expectedPartIdsFor(sessionId: string): string[] {
  if (sessionId === ROOT_SESSION_ID) {
    return [ROOT_READ_PART_ID, ROOT_TASK_PART_ID, ROOT_FILE_PART_ID];
  }
  if (sessionId === CHILD_SESSION_ID) {
    return [CHILD_BASH_PART_ID];
  }
  throw new Error(`Unknown fixture session id: ${sessionId}`);
}

export function buildSessionItem(params: {
  sessionId: string;
  slug: string;
  title: string;
  parentId?: string;
}): SessionIngestItem {
  return {
    type: 'session',
    data: {
      id: params.sessionId,
      slug: params.slug,
      projectID: FIXTURE_PROJECT_ID,
      directory: FIXTURE_DIRECTORY,
      ...(params.parentId === undefined ? {} : { parentID: params.parentId }),
      title: params.title,
      version: FIXTURE_SESSION_VERSION,
      time: { created: FIXTURE_TIME_CREATED, updated: FIXTURE_TIME_UPDATED },
    },
  };
}

export function buildUserMessageItem(params: {
  messageId: string;
  sessionId: string;
  createdAt: number;
}): SessionIngestItem {
  return {
    type: 'message',
    data: {
      id: params.messageId,
      sessionID: params.sessionId,
      role: 'user',
      time: { created: params.createdAt },
      agent: FIXTURE_AGENT,
      model: { providerID: MODEL_PROVIDER_ID, modelID: MODEL_ID },
    },
  };
}

export function buildAssistantMessageItem(params: {
  messageId: string;
  sessionId: string;
  parentId: string;
  createdAt: number;
  completedAt: number;
  cost: number;
  tokens: FixtureTokens;
}): SessionIngestItem {
  return {
    type: 'message',
    data: {
      id: params.messageId,
      sessionID: params.sessionId,
      role: 'assistant',
      time: { created: params.createdAt, completed: params.completedAt },
      parentID: params.parentId,
      modelID: MODEL_ID,
      providerID: MODEL_PROVIDER_ID,
      mode: FIXTURE_MODE,
      agent: FIXTURE_AGENT,
      path: { cwd: FIXTURE_DIRECTORY, root: FIXTURE_DIRECTORY },
      cost: params.cost,
      tokens: params.tokens,
    },
  };
}

export function buildToolPartItem(params: {
  partId: string;
  sessionId: string;
  messageId: string;
  callId: string;
  tool: string;
  input: Record<string, unknown>;
  output: string;
  title: string;
  metadata: Record<string, unknown>;
  start: number;
  end: number;
}): SessionIngestItem {
  return {
    type: 'part',
    data: {
      id: params.partId,
      sessionID: params.sessionId,
      messageID: params.messageId,
      type: 'tool',
      callID: params.callId,
      tool: params.tool,
      state: {
        status: 'completed',
        input: params.input,
        output: params.output,
        title: params.title,
        metadata: params.metadata,
        time: { start: params.start, end: params.end },
      },
    },
  };
}

export function buildFilePartItem(params: {
  partId: string;
  sessionId: string;
  messageId: string;
  mime: string;
  filename: string;
  url: string;
}): SessionIngestItem {
  return {
    type: 'part',
    data: {
      id: params.partId,
      sessionID: params.sessionId,
      messageID: params.messageId,
      type: 'file',
      mime: params.mime,
      filename: params.filename,
      url: params.url,
    },
  };
}

export function buildRootIngestItems(): SessionIngestItem[] {
  return [
    buildSessionItem({
      sessionId: ROOT_SESSION_ID,
      slug: ROOT_SESSION_SLUG,
      title: ROOT_SESSION_TITLE,
    }),
    buildUserMessageItem({
      messageId: ROOT_USER_MESSAGE_ID,
      sessionId: ROOT_SESSION_ID,
      createdAt: ROOT_USER_CREATED,
    }),
    buildAssistantMessageItem({
      messageId: ROOT_ASSISTANT_MESSAGE_ID,
      sessionId: ROOT_SESSION_ID,
      parentId: ROOT_USER_MESSAGE_ID,
      createdAt: ROOT_ASSISTANT_CREATED,
      completedAt: ROOT_ASSISTANT_COMPLETED,
      cost: ROOT_ASSISTANT_COST,
      tokens: ROOT_ASSISTANT_TOKENS,
    }),
    buildToolPartItem({
      partId: ROOT_READ_PART_ID,
      sessionId: ROOT_SESSION_ID,
      messageId: ROOT_ASSISTANT_MESSAGE_ID,
      callId: 'callRootRead000001',
      tool: 'read',
      input: { filePath: '/workspace/direct-fixture.txt' },
      output: 'direct fixture output',
      title: 'Read direct-fixture.txt',
      metadata: {},
      start: ROOT_READ_START,
      end: ROOT_READ_END,
    }),
    buildToolPartItem({
      partId: ROOT_TASK_PART_ID,
      sessionId: ROOT_SESSION_ID,
      messageId: ROOT_ASSISTANT_MESSAGE_ID,
      callId: 'callRootTask000001',
      tool: 'task',
      input: { subagent_type: 'Explorer', description: CHILD_SESSION_TITLE },
      output: 'child fixture inspected',
      title: CHILD_SESSION_TITLE,
      metadata: { sessionId: CHILD_SESSION_ID },
      start: ROOT_TASK_START,
      end: ROOT_TASK_END,
    }),
    buildFilePartItem({
      partId: ROOT_FILE_PART_ID,
      sessionId: ROOT_SESSION_ID,
      messageId: ROOT_ASSISTANT_MESSAGE_ID,
      mime: ROOT_FILE_MIME,
      filename: ROOT_FILE_NAME,
      url: ROOT_FILE_URL,
    }),
  ];
}

export function buildChildIngestItems(): SessionIngestItem[] {
  return [
    buildSessionItem({
      sessionId: CHILD_SESSION_ID,
      slug: CHILD_SESSION_SLUG,
      title: CHILD_SESSION_TITLE,
      parentId: ROOT_SESSION_ID,
    }),
    buildUserMessageItem({
      messageId: CHILD_USER_MESSAGE_ID,
      sessionId: CHILD_SESSION_ID,
      createdAt: CHILD_USER_CREATED,
    }),
    buildAssistantMessageItem({
      messageId: CHILD_ASSISTANT_MESSAGE_ID,
      sessionId: CHILD_SESSION_ID,
      parentId: CHILD_USER_MESSAGE_ID,
      createdAt: CHILD_ASSISTANT_CREATED,
      completedAt: CHILD_ASSISTANT_COMPLETED,
      cost: CHILD_ASSISTANT_COST,
      tokens: CHILD_ASSISTANT_TOKENS,
    }),
    buildToolPartItem({
      partId: CHILD_BASH_PART_ID,
      sessionId: CHILD_SESSION_ID,
      messageId: CHILD_ASSISTANT_MESSAGE_ID,
      callId: 'callChildBash00001',
      tool: 'bash',
      input: { command: 'printf child-fixture' },
      output: 'child fixture output',
      title: 'Run child fixture command',
      metadata: {},
      start: CHILD_BASH_START,
      end: CHILD_BASH_END,
    }),
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parses the `pnpm -s dev:status --json` output and returns the
 * `cloudflare-session-ingest` service entry. Throws when the service is
 * missing or its status/port fields are malformed.
 */
export function parseSessionIngestServiceStatus(json: string): SessionIngestServiceStatus {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('dev:status --json did not return valid JSON');
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.services)) {
    throw new Error('dev:status --json returned no services array');
  }

  const entry = parsed.services.find(
    (service): service is Record<string, unknown> =>
      isRecord(service) && service.name === SESSION_INGEST_SERVICE_NAME
  );
  if (!entry) {
    throw new Error(`dev:status --json did not report the ${SESSION_INGEST_SERVICE_NAME} service`);
  }

  if (entry.status !== 'up' && entry.status !== 'down') {
    throw new Error(
      `dev:status --json reported an invalid status for ${SESSION_INGEST_SERVICE_NAME}`
    );
  }
  if (typeof entry.port !== 'number' || !Number.isInteger(entry.port) || entry.port <= 0) {
    throw new Error(
      `dev:status --json reported an invalid port for ${SESSION_INGEST_SERVICE_NAME}`
    );
  }

  return {
    name: SESSION_INGEST_SERVICE_NAME,
    status: entry.status,
    port: entry.port,
  };
}
