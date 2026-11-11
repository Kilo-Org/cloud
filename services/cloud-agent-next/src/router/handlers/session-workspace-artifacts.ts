import { TRPCError } from '@trpc/server';
import { createR2Client } from '@kilocode/worker-utils/r2-client';
import {
  deleteWorkspaceArtifactOutputSchema,
  getWorkspaceArtifactDownloadUrlOutputSchema,
  listWorkspaceArtifactsOutputSchema,
  workspaceArtifactDeleteInputSchema,
  workspaceArtifactDownloadInputSchema,
  workspaceArtifactSessionInputSchema,
} from '@kilocode/worker-utils/cloud-agent-workspace-artifacts';
import { WORKSPACE_ARTIFACT_DOWNLOAD_URL_SECONDS } from '../../shared/workspace-artifacts.js';
import { logger, withLogTags } from '../../logger.js';
import type { SessionMetadata } from '../../persistence/session-metadata.js';
import { generateSandboxId } from '../../sandbox-id.js';
import { getSandboxControlStub } from '../../sandbox-control/stub.js';
import { getSandboxSessionStub } from '../../sandbox-session/session-stub.js';
import { requireCurrentSessionAccess } from '../../session-access.js';
import type { Env } from '../../types.js';
import { withDORetry } from '../../utils/do-retry.js';
import { protectedProcedure } from '../auth.js';
import { sessionIdSchema } from '../schemas.js';

type SandboxControlStub = ReturnType<typeof getSandboxControlStub>;
type SandboxTransferEnv = Pick<
  Env,
  | 'R2_ENDPOINT'
  | 'WORKSPACE_ARTIFACTS_BUCKET_NAME'
  | 'WORKSPACE_ARTIFACTS_READONLY_ACCESS_KEY_ID'
  | 'WORKSPACE_ARTIFACTS_READONLY_SECRET_ACCESS_KEY'
>;

const ListWorkspaceArtifactsInput = workspaceArtifactSessionInputSchema.extend({
  cloudAgentSessionId: sessionIdSchema,
});

const GetWorkspaceArtifactDownloadUrlInput = workspaceArtifactDownloadInputSchema.extend({
  cloudAgentSessionId: sessionIdSchema,
});

const DeleteWorkspaceArtifactInput = workspaceArtifactDeleteInputSchema.extend({
  cloudAgentSessionId: sessionIdSchema,
});

async function resolveWorkspaceArtifactSandboxId(
  env: Env,
  userId: string,
  cloudAgentSessionId: string
): Promise<string> {
  const access = await requireCurrentSessionAccess({
    env,
    kiloUserId: userId,
    cloudAgentSessionId,
  });

  const metadata = await withDORetry(
    () => getSandboxSessionStub(env, userId, cloudAgentSessionId),
    (session): Promise<SessionMetadata | null> => session.getMetadata(),
    'getMetadata'
  );
  if (!metadata) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Session not found' });
  }
  if (
    metadata.identity.userId !== userId ||
    metadata.identity.sessionId !== cloudAgentSessionId ||
    (metadata.identity.orgId ?? null) !== access.organizationId
  ) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Session access denied' });
  }

  const sandboxId = metadata.workspace?.sandboxId;
  if (sandboxId) return sandboxId;
  return await generateSandboxId(metadata.identity.sessionId, {
    createdOnPlatform: metadata.identity.createdOnPlatform,
  });
}

function workspaceArtifactsFor<T>(
  env: Pick<Env, 'SANDBOX_CONTROL'>,
  sandboxId: string,
  operation: (stub: SandboxControlStub) => Promise<T>
): Promise<T> {
  return withDORetry(() => getSandboxControlStub(env, sandboxId), operation, 'workspaceArtifacts');
}

function requireDownloadConfig(env: SandboxTransferEnv): {
  bucketName: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint: string;
} {
  const bucketName = env.WORKSPACE_ARTIFACTS_BUCKET_NAME;
  const accessKeyId = env.WORKSPACE_ARTIFACTS_READONLY_ACCESS_KEY_ID;
  const secretAccessKey = env.WORKSPACE_ARTIFACTS_READONLY_SECRET_ACCESS_KEY;
  const endpoint = env.R2_ENDPOINT;

  if (!bucketName || !accessKeyId || !secretAccessKey || !endpoint) {
    logger.warn('Workspace artifact downloads are not configured', {
      hasBucketName: Boolean(bucketName),
      hasAccessKeyId: Boolean(accessKeyId),
      hasSecretAccessKey: Boolean(secretAccessKey),
      hasEndpoint: Boolean(endpoint),
    });
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Workspace artifact downloads are not configured',
    });
  }

  return { bucketName, accessKeyId, secretAccessKey, endpoint };
}

function encodeRfc5987Value(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function isActiveMarkupContentType(contentType: string): boolean {
  const normalized = contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return (
    normalized === 'text/html' ||
    normalized === 'application/xml' ||
    normalized === 'text/xml' ||
    normalized.endsWith('+xml')
  );
}

function attachmentDisposition(relativePath: string): string {
  const fileName = relativePath.slice(relativePath.lastIndexOf('/') + 1);
  return `attachment; filename*=UTF-8''${encodeRfc5987Value(fileName)}`;
}

export function createSessionWorkspaceArtifactsHandlers() {
  return {
    listWorkspaceArtifacts: protectedProcedure
      .input(ListWorkspaceArtifactsInput)
      .output(listWorkspaceArtifactsOutputSchema)
      .query(({ input, ctx }) =>
        withLogTags({ source: 'listWorkspaceArtifacts' }, async () => {
          const sandboxId = await resolveWorkspaceArtifactSandboxId(
            ctx.env,
            ctx.userId,
            input.cloudAgentSessionId
          );
          logger.setTags({
            userId: ctx.userId,
            sessionId: input.cloudAgentSessionId,
            sandboxId,
          });
          return workspaceArtifactsFor(ctx.env, sandboxId, stub => stub.listWorkspaceArtifacts());
        })
      ),

    getWorkspaceArtifactDownloadUrl: protectedProcedure
      .input(GetWorkspaceArtifactDownloadUrlInput)
      .output(getWorkspaceArtifactDownloadUrlOutputSchema)
      .query(({ input, ctx }) =>
        withLogTags({ source: 'getWorkspaceArtifactDownloadUrl' }, async () => {
          const sandboxId = await resolveWorkspaceArtifactSandboxId(
            ctx.env,
            ctx.userId,
            input.cloudAgentSessionId
          );
          logger.setTags({
            userId: ctx.userId,
            sessionId: input.cloudAgentSessionId,
            sandboxId,
          });

          const config = requireDownloadConfig(ctx.env);
          const artifact = await workspaceArtifactsFor(ctx.env, sandboxId, stub =>
            stub.getWorkspaceArtifact(input.relativePath)
          );
          if (artifact === null) {
            throw new TRPCError({ code: 'NOT_FOUND', message: 'Workspace artifact not found' });
          }

          const client = createR2Client({
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey,
            endpoint: config.endpoint,
          });
          const url = await client.getSignedURL(
            config.bucketName,
            artifact.objectKey,
            WORKSPACE_ARTIFACT_DOWNLOAD_URL_SECONDS,
            {
              responseContentDisposition: attachmentDisposition(input.relativePath),
              ...(isActiveMarkupContentType(artifact.entry.contentType)
                ? { responseContentType: 'application/octet-stream' }
                : {}),
            }
          );

          return {
            url,
            expiresAt: Date.now() + WORKSPACE_ARTIFACT_DOWNLOAD_URL_SECONDS * 1_000,
          };
        })
      ),

    deleteWorkspaceArtifact: protectedProcedure
      .input(DeleteWorkspaceArtifactInput)
      .output(deleteWorkspaceArtifactOutputSchema)
      .mutation(({ input, ctx }) =>
        withLogTags({ source: 'deleteWorkspaceArtifact' }, async () => {
          const sandboxId = await resolveWorkspaceArtifactSandboxId(
            ctx.env,
            ctx.userId,
            input.cloudAgentSessionId
          );
          logger.setTags({
            userId: ctx.userId,
            sessionId: input.cloudAgentSessionId,
            sandboxId,
          });
          return workspaceArtifactsFor(
            ctx.env,
            sandboxId,
            async stub =>
              await stub.deleteWorkspaceArtifactForUser({
                relativePath: input.relativePath,
                expectedHash: input.expectedHash,
              })
          );
        })
      ),
  };
}
