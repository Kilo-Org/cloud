import { GitRepositoryDO } from './git-repository-do';
import { PreviewDO } from './preview-do';
import { Sandbox } from '@cloudflare/sandbox';
import type { Env } from './types';
import { handleGitProtocolRequest, isGitProtocolRequest } from './handlers/git-protocol';
import { handleInit } from './handlers/init';
import { handleGenerateToken } from './handlers/token';
import { handleDelete } from './handlers/delete';
import { handleGetCommit } from './handlers/commit';
import { handleMigrateToGithub } from './handlers/migrate-to-github';
import {
  handleGetPreviewStatus,
  handlePreviewProxy,
  handleStreamBuildLogs,
  handleTriggerBuild,
} from './handlers/preview';
import { logger, withLogTags } from './utils/logger';

// Export Durable Objects
export { GitRepositoryDO, PreviewDO, Sandbox };

// Route patterns
const APP_ID_PATTERN_STR = '[a-z0-9_-]{20,}';
const APP_ID_PATTERN = new RegExp(`^${APP_ID_PATTERN_STR}$`);
const INIT_PATTERN = new RegExp(`^/apps/(${APP_ID_PATTERN_STR})/init$`);
const TOKEN_PATTERN = new RegExp(`^/apps/(${APP_ID_PATTERN_STR})/token$`);
const COMMIT_PATTERN = new RegExp(`^/apps/(${APP_ID_PATTERN_STR})/commit$`);
const PREVIEW_STATUS_PATTERN = new RegExp(`^/apps/(${APP_ID_PATTERN_STR})/preview$`);
const BUILD_TRIGGER_PATTERN = new RegExp(`^/apps/(${APP_ID_PATTERN_STR})/build$`);
const BUILD_LOGS_PATTERN = new RegExp(`^/apps/(${APP_ID_PATTERN_STR})/build/logs$`);
const MIGRATE_TO_GITHUB_PATTERN = new RegExp(`^/apps/(${APP_ID_PATTERN_STR})/migrate-to-github$`);
const DELETE_PATTERN = new RegExp(`^/apps/(${APP_ID_PATTERN_STR})$`);

// Dev Mode
let previewAppId: string | null = null;

/**
 * Extract app ID from subdomain if hostname matches app-id.BUILDER_HOSTNAME pattern
 */
function extractAppIdFromSubdomain(hostname: string, builderHostname: string): string | null {
  // Match pattern: app-id.BUILDER_HOSTNAME
  if (!builderHostname) return null;

  const suffix = `.${builderHostname}`;
  if (!hostname.endsWith(suffix)) return null;

  const appId = hostname.slice(0, -suffix.length);

  // Validate appId matches the expected pattern
  if (!appId || !APP_ID_PATTERN.test(appId)) {
    return null;
  }

  return appId;
}

/**
 * Extract app ID from pathname (e.g., /apps/{app_id}/init)
 */
function extractAppIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/apps\/([a-z0-9_-]{20,})/);
  return match ? match[1] : null;
}

/**
 * Main worker fetch handler
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return withLogTags({ source: 'worker' }, async () => {
      const url = new URL(request.url);
      const pathname = url.pathname;

      // Extract appId from subdomain or path for logging context
      const subdomainAppId = extractAppIdFromSubdomain(url.hostname, env.BUILDER_HOSTNAME);
      const pathAppId = extractAppIdFromPath(pathname);
      const appId = subdomainAppId ?? pathAppId;

      if (appId) {
        logger.setTags({ appId });
      }

      logger.info('Request received', {
        method: request.method,
        pathname,
      });

      if (subdomainAppId) {
        // All requests to app-id.* subdomain are proxied to the preview sandbox
        return handlePreviewProxy(request, env, subdomainAppId);
      }

      // Handle init requests
      const initMatch = pathname.match(INIT_PATTERN);
      if (initMatch && request.method === 'POST') {
        return handleInit(request, env, initMatch[1]);
      }

      // Handle token generation requests (POST /apps/{app_id}/token)
      const tokenMatch = pathname.match(TOKEN_PATTERN);
      if (tokenMatch && request.method === 'POST') {
        return handleGenerateToken(request, env, tokenMatch[1]);
      }

      // Handle commit hash requests (GET /apps/{app_id}/commit)
      const commitMatch = pathname.match(COMMIT_PATTERN);
      if (commitMatch && request.method === 'GET') {
        return handleGetCommit(request, env, commitMatch[1]);
      }

      // Handle preview status requests (GET /apps/{app_id}/preview)
      const previewStatusMatch = pathname.match(PREVIEW_STATUS_PATTERN);
      if (previewStatusMatch && request.method === 'GET') {
        const matchedAppId = previewStatusMatch[1];
        if (env.DEV_MODE) {
          previewAppId = matchedAppId;
        }
        return handleGetPreviewStatus(request, env, matchedAppId);
      }

      // Handle build trigger requests (POST /apps/{app_id}/build)
      const buildTriggerMatch = pathname.match(BUILD_TRIGGER_PATTERN);
      if (buildTriggerMatch && request.method === 'POST') {
        return handleTriggerBuild(request, env, buildTriggerMatch[1]);
      }

      // Handle build logs streaming requests (GET /apps/{app_id}/build/logs)
      const buildLogsMatch = pathname.match(BUILD_LOGS_PATTERN);
      if (buildLogsMatch && request.method === 'GET') {
        return handleStreamBuildLogs(request, env, buildLogsMatch[1]);
      }

      // Handle migrate to GitHub requests (POST /apps/{app_id}/migrate-to-github)
      const migrateToGithubMatch = pathname.match(MIGRATE_TO_GITHUB_PATTERN);
      if (migrateToGithubMatch && request.method === 'POST') {
        return handleMigrateToGithub(request, env, migrateToGithubMatch[1]);
      }

      // Handle delete requests (DELETE /apps/{app_id})
      const deleteMatch = pathname.match(DELETE_PATTERN);
      if (deleteMatch && request.method === 'DELETE') {
        return handleDelete(request, env, deleteMatch[1]);
      }

      // Handle git protocol requests
      if (isGitProtocolRequest(pathname)) {
        return handleGitProtocolRequest(request, env, ctx);
      }

      // Dev mode: When DEV_MODE is enabled and previewAppId is set,
      // proxy all requests to the preview sandbox. This allows testing preview
      // without subdomains in local development.
      if (env.DEV_MODE && previewAppId) {
        return handlePreviewProxy(request, env, previewAppId);
      }

      if (pathname === '/' || pathname === '') {
        return new Response('{}', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response('Not found', { status: 404 });
    });
  },
};
