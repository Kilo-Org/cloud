import { TRPCError } from '@trpc/server';
import { getSandbox } from '@cloudflare/sandbox';
import { logger, withLogTags } from '../../logger.js';
import {
  generateSessionId,
  SessionService,
  determineBranchName,
  runSetupCommands,
  writeMCPSettings,
} from '../../session-service.js';
import { InstallationLookupService } from '../../services/installation-lookup-service.js';
import { GitHubTokenService } from '../../services/github-token-service.js';
import { internalApiProtectedProcedure } from '../auth.js';
import {
  PrepareSessionInput,
  PrepareSessionOutput,
  UpdateSessionInput,
  UpdateSessionOutput,
} from '../schemas.js';
import { generateSandboxId } from '../../sandbox-id.js';
import type { SandboxId } from '../../types.js';
import { setupWorkspace, cloneGitHubRepo, cloneGitRepo, manageBranch } from '../../workspace.js';
import { ensureKiloServer, createKiloCliSession } from '../../kilo/server-manager.js';
import { withDORetry } from '../../utils/do-retry.js';

type SessionPrepareHandlers = {
  prepareSession: typeof prepareSessionHandler;
  updateSession: typeof updateSessionHandler;
};

function setUpdateValue(updates: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) {
    updates[key] = value;
  }
}

function setCollectionUpdate<T>(
  updates: Record<string, unknown>,
  key: string,
  value: T | undefined,
  isEmpty: (value: T) => boolean
): void {
  if (value === undefined) {
    return;
  }

  updates[key] = isEmpty(value) ? null : value;
}

/**
 * Creates session preparation handlers.
 * These handlers are protected by internal API authentication (backend-to-backend).
 * They support the prepare-then-initiate flow for AI Agents.
 */
export function createSessionPrepareHandlers(): SessionPrepareHandlers {
  return {
    prepareSession: prepareSessionHandler,
    updateSession: updateSessionHandler,
  };
}

/**
 * Prepare a new session for later initiation.
 *
 * This creates a fully prepared session with:
 * - Workspace directories created
 * - Git repository cloned
 * - Branch created/checked out
 * - Setup commands executed
 * - MCP settings configured
 * - Kilo server started
 * - Kilo CLI session created
 *
 * The session can then be updated via updateSession and initiated via startExecutionV2.
 *
 * Flow:
 * 1. Generate cloudAgentSessionId and sandboxId
 * 2. Get sandbox and setup workspace
 * 3. Clone repository and create branch
 * 4. Run setup commands and configure MCP
 * 5. Start kilo server and create CLI session
 * 6. Store all metadata in Durable Object
 * 7. Return { cloudAgentSessionId, kiloSessionId }
 *
 * Protected by internal API authentication (x-internal-api-key header).
 */
const prepareSessionHandler = internalApiProtectedProcedure
  .input(PrepareSessionInput)
  .output(PrepareSessionOutput)
  .mutation(async ({ input, ctx }) => {
    return withLogTags({ source: 'prepareSession' }, async () => {
      const sessionService = new SessionService();

      // 1. Generate new cloudAgentSessionId and sandboxId
      const cloudAgentSessionId = generateSessionId();
      const sandboxId: SandboxId = await generateSandboxId(
        input.kilocodeOrganizationId,
        ctx.userId,
        ctx.botId
      );

      logger.setTags({
        cloudAgentSessionId,
        userId: ctx.userId,
        orgId: input.kilocodeOrganizationId ?? '(personal)',
        sandboxId,
      });
      logger.info('Preparing new session with workspace setup');

      // 2. Lookup GitHub installation ID from database when using a GitHub repo without a token
      let resolvedInstallationId: string | undefined;
      let resolvedGithubAppType: 'standard' | 'lite' | undefined;
      if (input.githubRepo && !input.githubToken) {
        const lookupService = new InstallationLookupService(ctx.env);
        logger
          .withFields({ hyperdriveConfigured: lookupService.isConfigured() })
          .info('Checking for GitHub installation ID lookup');
        if (lookupService.isConfigured()) {
          try {
            const result = await lookupService.findInstallationId({
              githubRepo: input.githubRepo,
              userId: ctx.userId,
              orgId: input.kilocodeOrganizationId,
            });
            logger
              .withFields({
                found: !!result,
                githubRepo: input.githubRepo,
                userId: ctx.userId,
                orgId: input.kilocodeOrganizationId,
              })
              .info('Installation lookup result');
            if (result) {
              resolvedInstallationId = result.installationId;
              resolvedGithubAppType = result.githubAppType;
              logger
                .withFields({
                  installationId: result.installationId,
                  accountLogin: result.accountLogin,
                  githubAppType: result.githubAppType,
                })
                .info('Resolved GitHub installation ID from database');
            }
          } catch (lookupError) {
            logger
              .withFields({
                error: lookupError instanceof Error ? lookupError.message : String(lookupError),
              })
              .error('Failed to lookup GitHub installation ID');
            // Don't throw - fall through to the validation error
          }
        }
      }

      // Validate that we have auth for GitHub repo
      if (input.githubRepo && !input.githubToken && !resolvedInstallationId) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'GitHub token or active app installation required for this repository',
        });
      }

      // Generate token from installation ID if using GitHub App auth
      let resolvedGithubToken = input.githubToken;
      if (input.githubRepo && !input.githubToken && resolvedInstallationId) {
        const tokenService = new GitHubTokenService(ctx.env);
        if (!tokenService.isConfigured(resolvedGithubAppType ?? 'standard')) {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'GitHub App credentials not configured',
          });
        }
        try {
          resolvedGithubToken = await tokenService.getToken(
            resolvedInstallationId,
            resolvedGithubAppType ?? 'standard'
          );
          logger.info('Generated GitHub token from installation');
        } catch (tokenError) {
          logger
            .withFields({
              error: tokenError instanceof Error ? tokenError.message : String(tokenError),
              installationId: resolvedInstallationId,
            })
            .error('Failed to generate GitHub token from installation');
          throw new TRPCError({
            code: 'BAD_GATEWAY',
            message: `Failed to generate GitHub token: ${tokenError instanceof Error ? tokenError.message : String(tokenError)}`,
          });
        }
      }

      // NOTE: Backend session creation (createKiloSessionInBackend) is temporarily disabled.
      // The kiloSessionId will now come from the kilo CLI server's POST /session API.
      // This can be re-enabled later if backend analytics/tracking is needed.
      // const gitUrlForBackend = input.githubRepo
      //   ? `https://github.com/${input.githubRepo}`
      //   : input.gitUrl;
      // let backendKiloSessionId: string;
      // try {
      //   backendKiloSessionId = await sessionService.createKiloSessionInBackend(
      //     cloudAgentSessionId,
      //     ctx.authToken,
      //     ctx.env,
      //     input.kilocodeOrganizationId,
      //     input.mode,
      //     input.model,
      //     gitUrlForBackend
      //   );
      // } catch (error) {
      //   logger
      //     .withFields({ error: error instanceof Error ? error.message : String(error) })
      //     .error('Failed to create cliSession in backend');
      //   throw new TRPCError({
      //     code: 'INTERNAL_SERVER_ERROR',
      //     message: `Failed to create session in backend: ${
      //       error instanceof Error ? error.message : String(error)
      //     }`,
      //   });
      // }

      // 3. Get sandbox
      logger.info('Getting sandbox');
      const sandbox = getSandbox(ctx.env.Sandbox, sandboxId, { sleepAfter: 900 });

      // 4. Setup workspace directories
      logger.info('Setting up workspace directories');
      const { workspacePath, sessionHome } = await setupWorkspace(
        sandbox,
        ctx.userId,
        input.kilocodeOrganizationId,
        cloudAgentSessionId
      );

      // 5. Build context and create execution session
      const branchName = determineBranchName(cloudAgentSessionId, input.upstreamBranch);
      const context = sessionService.buildContext({
        sandboxId,
        orgId: input.kilocodeOrganizationId,
        userId: ctx.userId,
        sessionId: cloudAgentSessionId,
        workspacePath,
        sessionHome,
        githubRepo: input.githubRepo,
        githubToken: resolvedGithubToken, // Use resolved token (from input or generated from installation)
        gitUrl: input.gitUrl,
        gitToken: input.gitToken,
        upstreamBranch: input.upstreamBranch,
        botId: ctx.botId,
      });

      logger.info('Creating execution session');
      const session = await sessionService.getOrCreateSession(
        sandbox,
        context,
        ctx.env,
        ctx.authToken,
        input.model,
        input.kilocodeOrganizationId,
        input.encryptedSecrets,
        undefined, // createdOnPlatform
        input.appendSystemPrompt
      );

      // 6. Clone repository
      logger.info('Cloning repository');
      if (input.gitUrl) {
        await cloneGitRepo(session, workspacePath, input.gitUrl, input.gitToken);
      } else if (input.githubRepo) {
        await cloneGitHubRepo(session, workspacePath, input.githubRepo, resolvedGithubToken, {
          GITHUB_APP_SLUG: ctx.env.GITHUB_APP_SLUG,
          GITHUB_APP_BOT_USER_ID: ctx.env.GITHUB_APP_BOT_USER_ID,
        });
      } else {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Either githubRepo or gitUrl must be provided',
        });
      }

      // 7. Branch management
      logger
        .withFields({ branchName, upstreamBranch: input.upstreamBranch })
        .info('Managing branch');
      if (input.upstreamBranch) {
        // For upstream branches, use manageBranch (verifies exists remotely)
        await manageBranch(session, workspacePath, branchName, true);
      } else {
        // For session branches, create directly (can't exist remotely with UUID-based name)
        const result = await session.exec(`cd ${workspacePath} && git checkout -b '${branchName}'`);
        if (result.exitCode !== 0) {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: `Failed to create branch ${branchName}: ${result.stderr || result.stdout}`,
          });
        }
      }

      // 8. Run setup commands
      if (input.setupCommands && input.setupCommands.length > 0) {
        logger.withFields({ count: input.setupCommands.length }).info('Running setup commands');
        await runSetupCommands(session, context, input.setupCommands, true); // fail-fast
      }

      // 9. Write MCP settings
      if (input.mcpServers && Object.keys(input.mcpServers).length > 0) {
        logger
          .withFields({ count: Object.keys(input.mcpServers).length })
          .info('Writing MCP settings');
        await writeMCPSettings(sandbox, sessionHome, input.mcpServers);
      }

      // 10. Start kilo server
      logger.info('Starting kilo server');
      const kiloServerPort = await ensureKiloServer(
        sandbox,
        session,
        cloudAgentSessionId,
        workspacePath
      );

      // 11. Create kilo CLI session
      logger.info('Creating kilo CLI session');
      const kiloSession = await createKiloCliSession(session, kiloServerPort);
      const kiloSessionId = kiloSession.id;

      logger.setTags({ kiloSessionId });
      logger.info('Created kilo CLI session');

      // 12. Get DO stub and store metadata
      const doId = ctx.env.CLOUD_AGENT_SESSION.idFromName(`${ctx.userId}:${cloudAgentSessionId}`);
      const stub = ctx.env.CLOUD_AGENT_SESSION.get(doId);

      const prepareResult = await stub.prepare({
        sessionId: cloudAgentSessionId,
        userId: ctx.userId,
        orgId: input.kilocodeOrganizationId,
        botId: ctx.botId,
        kiloSessionId,
        prompt: input.prompt,
        mode: input.mode,
        model: input.model,
        kilocodeToken: ctx.authToken,
        githubRepo: input.githubRepo,
        githubToken: input.githubToken,
        githubInstallationId: resolvedInstallationId,
        githubAppType: resolvedGithubAppType,
        gitUrl: input.gitUrl,
        gitToken: input.gitToken,
        envVars: input.envVars,
        encryptedSecrets: input.encryptedSecrets,
        setupCommands: input.setupCommands,
        mcpServers: input.mcpServers,
        upstreamBranch: input.upstreamBranch,
        autoCommit: input.autoCommit,
        condenseOnComplete: input.condenseOnComplete,
        appendSystemPrompt: input.appendSystemPrompt,
        callbackTarget: input.callbackTarget,
        images: input.images,
        // Workspace metadata
        workspacePath,
        sessionHome,
        branchName,
        sandboxId,
      });

      if (!prepareResult.success) {
        logger.withFields({ error: prepareResult.error }).error('Failed to prepare session in DO');
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: prepareResult.error ?? 'Failed to prepare session',
        });
      }

      // 13. Record kilo server activity for idle timeout tracking
      try {
        await withDORetry(
          () => ctx.env.CLOUD_AGENT_SESSION.get(doId),
          s => s.recordKiloServerActivity(),
          'recordKiloServerActivity'
        );
      } catch (error) {
        // Non-fatal - log but continue
        logger
          .withFields({ error: error instanceof Error ? error.message : String(error) })
          .warn('Failed to record kilo server activity');
      }

      logger.info('Session prepared successfully');

      // 14. Return both IDs
      return { cloudAgentSessionId, kiloSessionId };
    });
  });

/**
 * Update a prepared (but not yet initiated) session.
 *
 * This allows modifying session configuration before initiation.
 * - undefined: skip field (no change)
 * - null: clear field
 * - value: set field to value
 * - For collections, empty array/object clears them
 *
 * Protected by internal API authentication (x-internal-api-key header).
 */
const updateSessionHandler = internalApiProtectedProcedure
  .input(UpdateSessionInput)
  .output(UpdateSessionOutput)
  .mutation(async ({ input, ctx }) => {
    return withLogTags({ source: 'updateSession' }, async () => {
      logger.setTags({
        cloudAgentSessionId: input.cloudAgentSessionId,
        userId: ctx.userId,
      });
      logger.info('Updating session');

      // 1. Get DO stub
      const doId = ctx.env.CLOUD_AGENT_SESSION.idFromName(
        `${ctx.userId}:${input.cloudAgentSessionId}`
      );
      const stub = ctx.env.CLOUD_AGENT_SESSION.get(doId);

      // 2. Build update object
      const updates: Record<string, unknown> = {};

      // Scalar fields - pass through as-is (undefined skips, null clears, value sets)
      setUpdateValue(updates, 'mode', input.mode);
      setUpdateValue(updates, 'model', input.model);
      setUpdateValue(updates, 'githubToken', input.githubToken);
      setUpdateValue(updates, 'gitToken', input.gitToken);
      setUpdateValue(updates, 'upstreamBranch', input.upstreamBranch);
      setUpdateValue(updates, 'autoCommit', input.autoCommit);
      setUpdateValue(updates, 'condenseOnComplete', input.condenseOnComplete);
      setUpdateValue(updates, 'appendSystemPrompt', input.appendSystemPrompt);
      setUpdateValue(updates, 'callbackTarget', input.callbackTarget);

      // Collection fields - empty = clear (converted to null for DO)
      setCollectionUpdate(updates, 'envVars', input.envVars, value => {
        return Object.keys(value).length === 0;
      });
      setCollectionUpdate(updates, 'encryptedSecrets', input.encryptedSecrets, value => {
        return Object.keys(value).length === 0;
      });
      setCollectionUpdate(updates, 'setupCommands', input.setupCommands, value => {
        return value.length === 0;
      });
      setCollectionUpdate(updates, 'mcpServers', input.mcpServers, value => {
        return Object.keys(value).length === 0;
      });

      // 3. Call tryUpdate() on DO
      const result = await stub.tryUpdate(updates);

      if (!result.success) {
        logger.withFields({ error: result.error }).error('Failed to update session');
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: result.error ?? 'Failed to update session',
        });
      }

      logger.info('Session updated successfully');

      return { success: true };
    });
  });
