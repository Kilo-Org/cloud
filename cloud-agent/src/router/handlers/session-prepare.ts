import { TRPCError } from '@trpc/server';
import { logger, withLogTags } from '../../logger.js';
import { generateSessionId, SessionService } from '../../session-service.js';
import { InstallationLookupService } from '../../services/installation-lookup-service.js';
import { internalApiProtectedProcedure } from '../auth.js';
import {
  PrepareSessionInput,
  PrepareSessionOutput,
  PrepareLegacySessionInput,
  PrepareLegacySessionOutput,
  UpdateSessionInput,
  UpdateSessionOutput,
} from '../schemas.js';

type SessionPrepareHandlers = {
  prepareSession: typeof prepareSessionHandler;
  prepareLegacySession: typeof prepareLegacySessionHandler;
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
    prepareLegacySession: prepareLegacySessionHandler,
    updateSession: updateSessionHandler,
  };
}

/**
 * Prepare a new session for later initiation.
 *
 * This creates a session in the "prepared" state with all configuration
 * stored in the Durable Object. The session can then be updated via
 * updateSession and finally initiated via initiateSessionStream.
 *
 * Flow:
 * 1. Generate cloudAgentSessionId
 * 2. Create cliSession in kilocode-backend (returns kiloSessionId)
 * 3. Store all metadata in Durable Object
 * 4. Return both IDs
 *
 * Protected by internal API authentication (x-internal-api-key header).
 */
const prepareSessionHandler = internalApiProtectedProcedure
  .input(PrepareSessionInput)
  .output(PrepareSessionOutput)
  .mutation(async ({ input, ctx }) => {
    return withLogTags({ source: 'prepareSession' }, async () => {
      const sessionService = new SessionService();

      // 1. Generate new cloudAgentSessionId
      const cloudAgentSessionId = generateSessionId();

      // 2. Create cliSession in kilocode-backend FIRST
      // This returns the generated kiloSessionId
      // If this fails, no DO state is created (clean failure)
      // Construct git_url from githubRepo or use gitUrl directly
      const gitUrlForBackend = input.githubRepo
        ? `https://github.com/${input.githubRepo}`
        : input.gitUrl;

      logger.setTags({
        cloudAgentSessionId,
        userId: ctx.userId,
        orgId: input.kilocodeOrganizationId ?? '(personal)',
      });
      logger.info('Preparing new session');

      // Lookup GitHub installation ID from database when using a GitHub repo without a token
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

      // 2. Create cliSession in kilocode-backend FIRST
      // This returns the generated kiloSessionId
      // If this fails, no DO state is created (clean failure)
      // Note: We don't pass gitUrl here - the CLI will report it when it runs
      let kiloSessionId: string;
      try {
        kiloSessionId = await sessionService.createKiloSessionInBackend(
          cloudAgentSessionId,
          ctx.authToken,
          ctx.env,
          input.kilocodeOrganizationId,
          input.mode,
          input.model,
          gitUrlForBackend
        );
      } catch (error) {
        logger
          .withFields({ error: error instanceof Error ? error.message : String(error) })
          .error('Failed to create cliSession in backend');
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to create session in backend: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      }

      logger.setTags({ kiloSessionId });
      logger.info('Created cliSession in backend');

      // 3. Get DO stub
      const doId = ctx.env.CLOUD_AGENT_SESSION.idFromName(`${ctx.userId}:${cloudAgentSessionId}`);
      const stub = ctx.env.CLOUD_AGENT_SESSION.get(doId);

      // 4. Call prepare() on DO with the kiloSessionId from backend
      const result = await stub.prepare({
        sessionId: cloudAgentSessionId,
        userId: ctx.userId,
        orgId: input.kilocodeOrganizationId,
        kiloSessionId,
        prompt: input.prompt,
        mode: input.mode,
        model: input.model,
        kilocodeToken: ctx.authToken, // Store token for queue runner
        githubRepo: input.githubRepo,
        githubToken: input.githubToken,
        githubInstallationId: resolvedInstallationId,
        githubAppType: resolvedGithubAppType,
        gitUrl: input.gitUrl,
        gitToken: input.gitToken,
        platform: input.platform,
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
      });

      if (!result.success) {
        logger.withFields({ error: result.error }).error('Failed to prepare session in DO');

        // Rollback: delete the cliSession we created in backend
        try {
          await sessionService.deleteKiloSessionInBackend(kiloSessionId, ctx.authToken, ctx.env);
          logger.info('Rolled back cliSession after DO prepare failure');
        } catch (rollbackError) {
          // Log but don't throw - the original error is more important
          logger
            .withFields({
              rollbackError:
                rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
            })
            .warn('Failed to rollback cliSession after DO prepare failure');
        }

        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: result.error ?? 'Failed to prepare session',
        });
      }

      logger.info('Session prepared successfully');

      // 5. Return both IDs
      return { cloudAgentSessionId, kiloSessionId };
    });
  });

/**
 * Prepare an existing session for later initiation.
 *
 * Uses an existing cloudAgentSessionId + kiloSessionId pair and stores
 * metadata in the DO without creating a new CLI session.
 */
const prepareLegacySessionHandler = internalApiProtectedProcedure
  .input(PrepareLegacySessionInput)
  .output(PrepareLegacySessionOutput)
  .mutation(async ({ input, ctx }) => {
    return withLogTags({ source: 'prepareLegacySession' }, async () => {
      const { cloudAgentSessionId, kiloSessionId, kilocodeOrganizationId, ...restInput } = input;

      logger.setTags({
        cloudAgentSessionId,
        kiloSessionId,
        userId: ctx.userId,
        orgId: kilocodeOrganizationId ?? '(personal)',
      });
      logger.info('Preparing legacy session');

      const doId = ctx.env.CLOUD_AGENT_SESSION.idFromName(`${ctx.userId}:${cloudAgentSessionId}`);
      const stub = ctx.env.CLOUD_AGENT_SESSION.get(doId);

      const result = await stub.prepare({
        sessionId: cloudAgentSessionId,
        userId: ctx.userId,
        orgId: kilocodeOrganizationId,
        kiloSessionId,
        kilocodeToken: ctx.authToken,
        ...restInput,
      });

      if (!result.success) {
        logger.withFields({ error: result.error }).error('Failed to prepare legacy session');
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: result.error ?? 'Failed to prepare session',
        });
      }

      logger.info('Legacy session prepared successfully');

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
