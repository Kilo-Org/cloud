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
  CONTROL_RUNTIME_RESERVED_ENV_VARS,
  RESERVED_ENV_VAR_PREFIXES,
} from '../../../src/shared/runtime-environment.js';
import { kiloServerEnvForOrigin } from '../../../src/shared/kilo-server-env.js';
import { type WrapperKiloClient } from '../kilo-api.js';

export type WorktreeKiloAuth = NonNullable<SessionAttachPayload['kilo']>;
type RuntimeIsolation = 'directory-shared' | 'per-session';

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

export function buildWorktreeKiloEnvironment(
  directory: string,
  home: string,
  kilo: WorktreeKiloAuth,
  environment: Record<string, string> = {},
  inherited: NodeJS.ProcessEnv = process.env,
  mcp?: SessionAttachPayload['mcp'],
  runtimeConfig?: Pick<
    ControlPlaneRouteSpec,
    'permission' | 'githubReviewTarget' | 'createdOnPlatform'
  > & {
    cloudAgentMcp?: ControlPlaneSessionCredentialsPayload['cloudAgentMcp'];
  }
): Record<string, string> {
  const env: Record<string, string> = {};
  const reserved = new Set<string>(CONTROL_RUNTIME_RESERVED_ENV_VARS);
  const isRuntimeOwned = (name: string): boolean =>
    reserved.has(name) ||
    name === 'HOME' ||
    RESERVED_ENV_VAR_PREFIXES.some(prefix => name.startsWith(prefix));

  for (const [name, value] of Object.entries(inherited)) {
    if (value !== undefined && !isRuntimeOwned(name) && !INHERITED_GIT_CREDENTIALS.has(name)) {
      env[name] = value;
    }
  }
  for (const [name, value] of Object.entries(environment)) {
    if (!isRuntimeOwned(name) || BITBUCKET_METADATA_ENV_VARS.has(name)) env[name] = value;
  }

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
      },
    },
    ...(mcp || runtimeConfig?.cloudAgentMcp
      ? {
          mcp: {
            ...Object.fromEntries(
              Object.entries(mcp ?? {}).filter(
                ([name]) => name !== GITHUB_REVIEW_MCP_SERVER_NAME && name !== 'kilo-cloud-agent'
              )
            ),
            ...(runtimeConfig?.cloudAgentMcp
              ? {
                  'kilo-cloud-agent': {
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
    ...(runtimeConfig?.githubReviewTarget
      ? {
          [GITHUB_REVIEW_TARGET_ENV]: serializeGitHubReviewTarget(runtimeConfig.githubReviewTarget),
        }
      : {}),
    KILO_DISABLE_AUTOUPDATE: 'true',
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
  };
}
