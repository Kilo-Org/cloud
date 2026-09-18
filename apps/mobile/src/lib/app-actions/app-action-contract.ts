// The four app actions the OS surfaces (Siri, Spotlight, Shortcuts, the Action
// button, Control Center, widget buttons) can run without opening the app.
//
// This module is the single description of them: their ids, their URL grammar,
// the JSON-object payload the native bridge sends, the destination each one
// resolves to, and the result shape the caller reports back. It is pure logic
// — no component, no native module — so every platform entry point and the
// tests share one contract.
//
// No destination here is invented: a session goes through
// `getAgentSessionPath` and a review through `providerPrRoutePath`, so an
// action lands on exactly the screen the in-app control reaches.

import { type Href } from 'expo-router';
import { z } from 'zod';

import { detectRepositoryPlatform } from '@/components/agents/new-session-repository-state';
import { getAgentSessionPath } from '@/components/agents/session-detail-routes';
import { parseProviderPrUrl } from '@/lib/pr-review/provider-pr-url';
import { providerPrRoutePath } from '@/lib/pr-review/provider-pr-ref';
import { shouldShowNeedsInput } from '@/lib/session-attention';

/** The four actions, in the order the OS surfaces list them. */
export const APP_ACTION_IDS = [
  'StartAgent',
  'OpenNeedsInput',
  'OpenSession',
  'OpenPullRequest',
] as const;

export type AppActionId = (typeof APP_ACTION_IDS)[number];

/** The dialect identifier of each action in `kiloapp:///actions/<slug>`. */
export const APP_ACTION_SLUGS = {
  StartAgent: 'start-agent',
  OpenNeedsInput: 'open-needs-input',
  OpenSession: 'open-session',
  OpenPullRequest: 'open-pull-request',
} as const satisfies Record<AppActionId, string>;

/** The path segment the action URLs live under. */
const ACTIONS_SEGMENT = 'actions';

/** The app's registered scheme (`app.config.ts`). */
const SCHEME_PREFIX = 'kiloapp://';

/**
 * Where `OpenNeedsInput` goes when the answer is not exactly one session: the
 * Agents tab, the same href `src/lib/deep-link-handler.ts` resolves to.
 */
const AGENTS_TAB_HREF = '/(app)/(tabs)/(2_agents)' as Href;

/** A request to run one of the four actions. */
export type AppActionRequest =
  | { action: 'StartAgent'; prompt: string; repository?: string; sessionId?: string }
  | { action: 'OpenNeedsInput' }
  | { action: 'OpenSession'; sessionId: string }
  | { action: 'OpenPullRequest'; pullRequest: string };

/**
 * What a run reports back to its caller. `message` is filled by the caller
 * from the existing catalog keys; this contract never carries copy.
 */
export type AppActionResult =
  | { ok: true; action: AppActionId; sessionId?: string; href?: string; message: string }
  | {
      ok: false;
      action: AppActionId;
      retryable: boolean;
      code:
        | 'empty-prompt'
        | 'unknown-repository'
        | 'unsupported-repository'
        | 'no-repository'
        | 'not-a-pull-request'
        | 'unknown-session'
        | 'start-failed';
      message: string;
    };

/** The four query fields an action URL or payload can carry. */
type AppActionField = 'prompt' | 'repository' | 'sessionId' | 'pullRequest';

/** Reads one optional field from a URL query or a decoded payload object. */
type FieldReader = (field: AppActionField) => string | null | undefined;

/** The action URL for a request: `kiloapp:///actions/<slug>?<query>`. */
export function appActionUrl(request: AppActionRequest): string {
  const params = new URLSearchParams();
  if (request.action === 'StartAgent') {
    if (request.prompt.length > 0) {
      params.set('prompt', request.prompt);
    }
    if (request.repository !== undefined) {
      params.set('repository', request.repository);
    }
    if (request.sessionId !== undefined) {
      params.set('sessionId', request.sessionId);
    }
  } else if (request.action === 'OpenSession') {
    params.set('sessionId', request.sessionId);
  } else if (request.action === 'OpenPullRequest') {
    params.set('pullRequest', request.pullRequest);
  }
  // OpenNeedsInput carries no fields: it answers from live data at the app.
  const query = params.toString();
  const suffix = query.length > 0 ? `?${query}` : '';
  return `${SCHEME_PREFIX}/${ACTIONS_SEGMENT}/${APP_ACTION_SLUGS[request.action]}${suffix}`;
}

/**
 * Parse a full action URL and the scheme-less path expo-router hands to
 * `redirectSystemPath`. Unknown slug, or a missing or blank required field,
 * yields null — never a half-built request.
 */
export function parseAppActionUrl(raw: string): AppActionRequest | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const { path, search } = splitActionTarget(trimmed);
  const slug = actionSlugFromPath(path);
  if (slug === null) {
    return null;
  }
  const id = actionIdFromSlug(slug);
  if (id === null) {
    return null;
  }
  const params = new URLSearchParams(search);
  return buildRequest(id, field => params.get(field));
}

/** The JSON payload schema the native bridge sends. */
const appActionPayloadSchema = z.object({
  action: z.string(),
  prompt: z.string().optional(),
  repository: z.string().optional(),
  sessionId: z.string().optional(),
  pullRequest: z.string().optional(),
});

type AppActionPayload = z.infer<typeof appActionPayloadSchema>;

const jsonTextSchema = z.string();

/**
 * Parse the JSON-object form the native bridge sends. A bridge that hands the
 * object through as JSON text is accepted too. Returns null when the payload
 * is not a known action or a required field is missing or blank — except a
 * `StartAgent` with no prompt and no session, which is returned as that action
 * so its `empty-prompt` refusal reaches the caller (see `requestFromPayload`).
 */
export function parseAppActionPayload(value: unknown): AppActionRequest | null {
  const direct = appActionPayloadSchema.safeParse(value);
  if (direct.success) {
    return requestFromPayload(direct.data);
  }
  const text = jsonTextSchema.safeParse(value);
  if (!text.success) {
    return null;
  }
  return parseJsonPayloadText(text.data);
}

/** Extra context a caller holds when it resolves a `StartAgent` destination. */
export type AppActionHrefInput = {
  /** The session id a `StartAgent` run created — required for its destination. */
  createdSessionId?: string;
};

/**
 * The destination for a request, or null when it cannot be resolved. The
 * routes come from the app's existing builders; `OpenNeedsInput` is
 * data-dependent and stays with `resolveNeedsInputHref`.
 */
export function appActionHref(request: AppActionRequest, input?: AppActionHrefInput): Href | null {
  if (request.action === 'OpenSession') {
    return getAgentSessionPath(request.sessionId);
  }
  if (request.action === 'OpenPullRequest') {
    const ref = parseProviderPrUrl(request.pullRequest);
    return ref === null ? null : providerPrRoutePath(ref);
  }
  if (request.action === 'StartAgent') {
    const createdSessionId = nonBlank(input?.createdSessionId);
    return createdSessionId === null ? null : getAgentSessionPath(createdSessionId);
  }
  return null;
}

/** One session row as the needs-input resolver sees it. */
export type NeedsInputSession = {
  id: string;
  status: string | null | undefined;
  isAcked: boolean;
};

/**
 * The destination for `OpenNeedsInput`: the single waiting session, or the
 * Agents tab when none or several are waiting. An acked row is not waiting.
 */
export function resolveNeedsInputHref(sessions: readonly NeedsInputSession[]): Href {
  const waiting = sessions.filter(session =>
    shouldShowNeedsInput({ status: session.status, raiseId: null, isAcked: session.isAcked })
  );
  const only = waiting.length === 1 ? waiting[0] : undefined;
  return only === undefined ? AGENTS_TAB_HREF : getAgentSessionPath(only.id);
}

/** A repository the `StartAgent` action can target, or the reason it cannot. */
export type ParsedActionRepository =
  | { kind: 'github' | 'gitlab'; fullName: string }
  | { kind: 'unsupported'; fullName: string };

/** A project-path segment the providers accept. */
const REPOSITORY_SEGMENT_PATTERN = /^[A-Za-z0-9_.-]+$/;

/**
 * Walk a path, dropping empty segments and a trailing `.git`, and reject any
 * shape the providers never name a project with. GitLab subgroups survive:
 * the full path is kept, not just its last segment.
 */
function repositoryPath(segments: readonly string[]): string | null {
  const raw = segments.filter(segment => segment.length > 0);
  if (raw.length === 0) {
    return null;
  }
  const cleaned = raw.map((segment, index) =>
    index === raw.length - 1 ? segment.replace(/\.git$/i, '') : segment
  );
  if (cleaned.some(segment => segment.length === 0 || !REPOSITORY_SEGMENT_PATTERN.test(segment))) {
    return null;
  }
  return cleaned.join('/');
}

/** The project path inside a `scheme://host/path` or `git@host:path` value. */
function urlRepositoryPath(raw: string): string | null {
  const scp = /^git@[^:]+:(.+)$/.exec(raw);
  if (scp) {
    return repositoryPath((scp[1] ?? '').split('/'));
  }
  const url = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/(?:[^@/]+@)?[^/?#]+(?:\/([^?#]*))?/.exec(raw);
  if (url) {
    return repositoryPath((url[1] ?? '').split('/'));
  }
  return null;
}

/**
 * Resolve the repository a `StartAgent` request names, from a repository URL,
 * a git URL, or the bare `owner/repo` form.
 *
 * Bitbucket is `unsupported` on purpose: the create call needs the workspace
 * and repository uuids that only the in-app picker holds
 * (`apps/web/src/routers/cloud-agent-next-schemas.ts`). The unsupported value
 * still carries the project path, so the refusal can name the repository it
 * cannot use. A host that is not a known provider is null (unknown); a bare
 * path with no host defaults to GitHub, whose repository form is exactly
 * `owner/repo` — a GitLab project with subgroups is addressed by its URL
 * instead.
 */
export function parseActionRepository(raw: string): ParsedActionRepository | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const platform = detectRepositoryPlatform(trimmed);
  if (platform === 'bitbucket') {
    return { kind: 'unsupported', fullName: urlRepositoryPath(trimmed) ?? trimmed };
  }
  if (platform === 'github' || platform === 'gitlab') {
    const fullName = urlRepositoryPath(trimmed);
    if (fullName === null) {
      return null;
    }
    if (platform === 'github' && fullName.split('/').length !== 2) {
      return null;
    }
    return { kind: platform, fullName };
  }
  const bare = repositoryPath(trimmed.split('/'));
  if (bare === null) {
    return null;
  }
  if (bare.split('/').length !== 2) {
    return null;
  }
  return { kind: 'github', fullName: bare };
}

/** A target split into its path and its query, fragment dropped. */
type ActionTarget = {
  path: string;
  search: string;
};

/** Split an action target into its path and query, dropping any fragment. */
function splitActionTarget(raw: string): ActionTarget {
  const hash = raw.indexOf('#');
  const withoutFragment = hash === -1 ? raw : raw.slice(0, hash);
  const question = withoutFragment.indexOf('?');
  if (question === -1) {
    return { path: withoutFragment, search: '' };
  }
  return {
    path: withoutFragment.slice(0, question),
    search: withoutFragment.slice(question + 1),
  };
}

/** The slug named by `/actions/<slug>`, or null for any other path. */
function actionSlugFromPath(path: string): string | null {
  const withoutScheme = path.startsWith(SCHEME_PREFIX) ? path.slice(SCHEME_PREFIX.length) : path;
  const segments = withoutScheme.split('/').filter(segment => segment.length > 0);
  if (segments.length !== 2 || segments[0] !== ACTIONS_SEGMENT) {
    return null;
  }
  return segments[1] ?? null;
}

/** The id named by one of the action slugs, or null. The URL grammar is slugs only. */
function actionIdFromSlug(slug: string): AppActionId | null {
  for (const id of APP_ACTION_IDS) {
    if (APP_ACTION_SLUGS[id] === slug) {
      return id;
    }
  }
  return null;
}

/** The id named by a payload's `action` field — an id or a slug, or null. */
function actionIdFromPayload(value: string): AppActionId | null {
  for (const id of APP_ACTION_IDS) {
    if (id === value || APP_ACTION_SLUGS[id] === value) {
      return id;
    }
  }
  return null;
}

/** A non-blank string, trimmed, or null. */
function nonBlank(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Assemble a request from its fields, or null when a required field is
 * missing or blank. Never returns a half-built request.
 */
function buildRequest(id: AppActionId, read: FieldReader): AppActionRequest | null {
  if (id === 'OpenNeedsInput') {
    return { action: 'OpenNeedsInput' };
  }
  if (id === 'OpenSession') {
    const sessionId = nonBlank(read('sessionId'));
    return sessionId === null ? null : { action: 'OpenSession', sessionId };
  }
  if (id === 'OpenPullRequest') {
    const pullRequest = nonBlank(read('pullRequest'));
    return pullRequest === null ? null : { action: 'OpenPullRequest', pullRequest };
  }
  // `prompt` is the plain start form; `sessionId` without a prompt is the
  // "start from a session" form. One of the two must be present.
  const prompt = read('prompt') ?? '';
  const sessionId = nonBlank(read('sessionId'));
  if (prompt.trim().length === 0 && sessionId === null) {
    return null;
  }
  const repository = nonBlank(read('repository'));
  return {
    action: 'StartAgent',
    prompt,
    ...(repository === null ? {} : { repository }),
    ...(sessionId === null ? {} : { sessionId }),
  };
}

/** Decode a JSON text payload, or null when it is not a known request. */
function parseJsonPayloadText(text: string): AppActionRequest | null {
  try {
    // `parse` throws on a wrong shape; `JSON.parse` throws on wrong syntax.
    return requestFromPayload(appActionPayloadSchema.parse(JSON.parse(text)));
  } catch {
    return null;
  }
}

/**
 * Map a decoded payload object onto a request, or null.
 *
 * A `StartAgent` payload with no prompt and no session is still the
 * `StartAgent` action — the caller named an action whose required input is
 * empty, not an action this payload grammar does not know. It resolves to the
 * request with the empty prompt, so the action path classifies it as the
 * contract's non-retryable `empty-prompt` result and the OS caller hears that
 * outcome. A blank `sessionId` or `pullRequest` on any other action is still no
 * request at all.
 */
function requestFromPayload(payload: AppActionPayload): AppActionRequest | null {
  const id = actionIdFromPayload(payload.action);
  if (id === null) {
    return null;
  }
  const fields: Partial<Record<AppActionField, string>> = {};
  if (payload.prompt !== undefined) {
    fields.prompt = payload.prompt;
  }
  if (payload.repository !== undefined) {
    fields.repository = payload.repository;
  }
  if (payload.sessionId !== undefined) {
    fields.sessionId = payload.sessionId;
  }
  if (payload.pullRequest !== undefined) {
    fields.pullRequest = payload.pullRequest;
  }
  const request = buildRequest(id, field => fields[field]);
  if (request !== null) {
    return request;
  }
  // `buildRequest` for `StartAgent` is null exactly when neither a prompt nor a
  // session was usable: hand it to the action path for the `empty-prompt`
  // refusal instead of rejecting the whole payload as unrecognized.
  if (id === 'StartAgent') {
    return { action: 'StartAgent', prompt: fields.prompt ?? '' };
  }
  return null;
}
