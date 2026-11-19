import path from 'node:path';

import { CONTROL_PLANE_SANDBOX_PERMISSION } from '../../../src/shared/control-plane-permission.js';
import type {
  ControlPlaneRouteSpec,
  ControlPlaneSessionCredentialsPayload,
} from '../../../src/shared/control-plane-protocol.js';
import {
  GITHUB_REVIEW_MCP_BINARY,
  GITHUB_REVIEW_MCP_SERVER_NAME,
  GITHUB_REVIEW_TARGET_ENV,
  serializeGitHubReviewTarget,
} from '../../../src/shared/github-review-target.js';
import { buildGitHubReviewPublishConfigContent } from '../github-review-publish-config.js';

import {
  type ControlErrorCode,
  type SessionAttachPayload,
  type SessionRequestIdentity,
} from '../../../src/shared/sandbox-control-protocol.js';
import {
  CLOUD_WEB_SEARCH_DISABLED_ENV,
  CLOUD_WEB_SEARCH_PROVIDER_ENV,
  RESERVED_ENV_VARS,
  RESERVED_ENV_VAR_PREFIXES,
  SYSTEM_GIT_CONFIG_ENV,
  isStrippedGitConfigEnvVar,
} from '../../../src/shared/runtime-environment.js';
import { kiloServerEnvForOrigin } from '../../../src/shared/kilo-server-env.js';
import { type WrapperKiloClient } from '../kilo-api.js';

export type WorktreeKiloAuth = NonNullable<SessionAttachPayload['kilo']>;
type RuntimeIsolation = 'directory-shared' | 'per-session';

/**
 * Reserved name of the workspace-owned built-in Cloud Agent MCP server. It
 * carries a rotating workspace credential, not user configuration, so it is
 * excluded from workspace-profile MCP sets and from MCP drift comparison.
 */
export const WORKSPACE_MCP_SERVER_NAME = 'kilo-cloud-agent';

export type WorktreeKiloRuntime = {
  readonly identity?: SessionRequestIdentity;
  readonly isolation?: RuntimeIsolation;
  readonly scopeId: string;
  readonly runtimeId: string;
  readonly directory: string;
  readonly env: Record<string, string>;
  readonly kiloClient: WrapperKiloClient;
  readonly signal: AbortSignal;
};
const MAX_KILO_CONFIG_BYTES = 96 * 1024;
const BITBUCKET_METADATA_ENV_VARS = new Set([
  'KILO_BITBUCKET_WORKSPACE_SLUG',
  'KILO_BITBUCKET_REPOSITORY_SLUG',
  'KILO_BITBUCKET_WORKSPACE_UUID',
  'KILO_BITBUCKET_REPOSITORY_UUID',
]);
const INHERITED_GIT_CREDENTIALS = new Set([
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GITLAB_TOKEN',
  'GITLAB_OAUTH_TOKEN',
  'BITBUCKET_TOKEN',
  'BITBUCKET_APP_PASSWORD',
]);

export class WorktreeKiloRuntimeError extends Error {
  constructor(
    readonly code: ControlErrorCode,
    message: string,
    readonly retryable: boolean
  ) {
    super(message);
    this.name = 'WorktreeKiloRuntimeError';
  }
}

/**
 * Personal per-model context caps become `provider.kilo.models.<id>.limit.context`
 * entries, so Kilo compacts the conversation against the lowered window. The
 * config key is the gateway model id without the `kilo/` provider prefix.
 */
function buildModelContextLimitEntries(
  limits: ControlPlaneRouteSpec['modelContextLimits']
): Record<string, { limit: { context: number } }> | undefined {
  if (!limits || Object.keys(limits).length === 0) return undefined;
  const entries: Record<string, { limit: { context: number } }> = {};
  for (const [model, context] of Object.entries(limits)) {
    const id = model.replace(/^kilo\//, '');
    if (id) entries[id] = { limit: { context } };
  }
  return Object.keys(entries).length > 0 ? entries : undefined;
}

export function buildWorktreeKiloEnvironment(
  directory: string,
  home: string,
  kilo: WorktreeKiloAuth,
  environment: Record<string, string> = {},
  inherited: NodeJS.ProcessEnv = process.env,
  mcp?: SessionAttachPayload['mcp'],
  runtimeConfig?: Pick<
    ControlPlaneRouteSpec,
    | 'permission'
    | 'githubReviewTarget'
    | 'createdOnPlatform'
    | 'modelContextLimits'
    | 'webSearchDisabled'
    | 'webSearchProvider'
  > & {
    cloudAgentMcp?: ControlPlaneSessionCredentialsPayload['cloudAgentMcp'];
  }
): Record<string, string> {
  const env: Record<string, string> = {};
  // The platform sets the control-runtime and session-identity names, and
  // supplies its own HOME and XDG paths below.
  const reserved = new Set<string>(RESERVED_ENV_VARS);
  const isRuntimeOwned = (name: string): boolean =>
    reserved.has(name) || RESERVED_ENV_VAR_PREFIXES.some(prefix => name.startsWith(prefix));

  for (const [name, value] of Object.entries(inherited)) {
    if (
      value !== undefined &&
      !isRuntimeOwned(name) &&
      !INHERITED_GIT_CREDENTIALS.has(name) &&
      !isStrippedGitConfigEnvVar(name)
    ) {
      env[name] = value;
    }
  }
  for (const [name, value] of Object.entries(environment)) {
    const runtimeOwned =
      reserved.has(name) || RESERVED_ENV_VAR_PREFIXES.some(prefix => name.startsWith(prefix));
    if (
      (!runtimeOwned || BITBUCKET_METADATA_ENV_VARS.has(name)) &&
      !isStrippedGitConfigEnvVar(name)
    ) {
      env[name] = value;
    }
  }

  const modelLimitEntries = buildModelContextLimitEntries(runtimeConfig?.modelContextLimits);
  let config = JSON.stringify({
    autoupdate: false,
    snapshot: false,
    permission: { ...CONTROL_PLANE_SANDBOX_PERMISSION, ...runtimeConfig?.permission },
    provider: {
      kilo: {
        options: {
          apiKey: kilo.token,
          kilocodeToken: kilo.token,
          ...(kilo.organizationId ? { kilocodeOrganizationId: kilo.organizationId } : {}),
          baseURL: kilo.targets.providerBaseUrl,
        },
        ...(modelLimitEntries ? { models: modelLimitEntries } : {}),
      },
    },
    ...(mcp || runtimeConfig?.cloudAgentMcp
      ? {
          mcp: {
            ...Object.fromEntries(
              Object.entries(mcp ?? {}).filter(
                ([name]) =>
                  name !== GITHUB_REVIEW_MCP_SERVER_NAME && name !== WORKSPACE_MCP_SERVER_NAME
              )
            ),
            ...(runtimeConfig?.cloudAgentMcp
              ? {
                  [WORKSPACE_MCP_SERVER_NAME]: {
                    type: 'remote',
                    url: runtimeConfig.cloudAgentMcp.url,
                    oauth: false,
                    headers: { Authorization: `Bearer ${runtimeConfig.cloudAgentMcp.token}` },
                  },
                }
              : {}),
          },
        }
      : {}),
  });
  if (runtimeConfig?.githubReviewTarget) {
    const amended = buildGitHubReviewPublishConfigContent({
      configContentJson: config,
      binaryPath: GITHUB_REVIEW_MCP_BINARY,
    });
    if (amended === null)
      throw new WorktreeKiloRuntimeError(
        'protocol_error',
        'GitHub review publisher configuration is invalid',
        false
      );
    config = amended;
  }
  if (Buffer.byteLength(config, 'utf8') > MAX_KILO_CONFIG_BYTES) {
    throw new WorktreeKiloRuntimeError('protocol_error', 'Kilo configuration is too large', false);
  }

  return {
    ...env,
    PWD: directory,
    HOME: home,
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'),
    XDG_RUNTIME_DIR: path.join(home, '.run'),
    KILO_PLATFORM: 'cloud-agent',
    ...(runtimeConfig?.webSearchDisabled ? { [CLOUD_WEB_SEARCH_DISABLED_ENV]: '1' } : {}),
    ...(runtimeConfig?.webSearchProvider
      ? { [CLOUD_WEB_SEARCH_PROVIDER_ENV]: runtimeConfig.webSearchProvider }
      : {}),
    ...(runtimeConfig?.githubReviewTarget
      ? {
          [GITHUB_REVIEW_TARGET_ENV]: serializeGitHubReviewTarget(runtimeConfig.githubReviewTarget),
        }
      : {}),
    KILO_DISABLE_AUTOUPDATE: 'true',
    // Backstop for a layout change or a non-symlinked gh-stack install: the
    // agent's terminals are real TTYs, so `gh` and gh-stack would otherwise run
    // their update checks and call the GitHub API with the session token.
    GH_NO_EXTENSION_UPDATE_NOTIFIER: '1',
    GH_STACK_NO_UPDATE_NOTIFIER: '1',
    KILO_DISABLE_CODEBASE_INDEXING: 'vscode-no-workspace',
    KILO_EXPERIMENTAL_BACKGROUND_SUBAGENTS: 'false',
    KILO_DEBUG_SESSION_INGEST: '1',
    ...kiloServerEnvForOrigin(runtimeConfig?.createdOnPlatform),
    KILOCODE_TOKEN: kilo.token,
    ...(kilo.organizationId ? { KILOCODE_ORGANIZATION_ID: kilo.organizationId } : {}),
    KILO_AUTH_CONTENT: JSON.stringify({ kilo: { type: 'api', key: kilo.token } }),
    KILOCODE_BACKEND_BASE_URL: kilo.targets.backendBaseUrl,
    KILO_API_URL: kilo.targets.backendBaseUrl,
    KILO_OPENROUTER_BASE: kilo.targets.providerBaseUrl,
    KILO_SESSION_INGEST_URL: kilo.targets.sessionIngestBaseUrl,
    KILO_CONFIG_CONTENT: config,
    OPENCODE_CONFIG_CONTENT: config,
    // Every process in the sandbox authenticates git through the platform's
    // read-only helper: the wrapper's own clone/fetch, the Kilo CLI and the
    // workspace terminal. The credential itself lives in the per-session record,
    // never in `origin`. Pinned last so profile values cannot displace it.
    ...SYSTEM_GIT_CONFIG_ENV,
    GIT_TERMINAL_PROMPT: '0',
  };
}
