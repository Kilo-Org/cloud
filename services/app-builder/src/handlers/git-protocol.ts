/**
 * Git Protocol Handler
 * Handles git clone/fetch/push operations via HTTP protocol
 * Routes: /apps/:id.git/info/refs, /apps/:id.git/git-upload-pack, /apps/:id.git/git-receive-pack
 */

import { GitCloneService } from '../git/git-clone-service';
import { GitReceivePackService } from '../git/git-receive-pack-service';
import { formatPacketLine } from '../git/git-protocol-utils';
import { MAX_OBJECT_SIZE } from '../git/constants';
import { logger, formatError } from '../utils/logger';
import { verifyGitAuth } from '../utils/auth';
import { notifyBackendOfPush } from '../utils/push-notification';
import type { GitRepositoryDO } from '../git-repository-do';
import type { Env } from '../types';

// Re-export Env type for backwards compatibility
export type { Env } from '../types';

/**
 * Git protocol route patterns
 */
const GIT_INFO_REFS_PATTERN = /^\/apps\/([a-z0-9_-]+)\.git\/info\/refs$/;
const GIT_UPLOAD_PACK_PATTERN = /^\/apps\/([a-z0-9_-]+)\.git\/git-upload-pack$/;
const GIT_RECEIVE_PACK_PATTERN = /^\/apps\/([a-z0-9_-]+)\.git\/git-receive-pack$/;

/**
 * Check if request is a Git protocol request
 */
export function isGitProtocolRequest(pathname: string): boolean {
  return (
    GIT_INFO_REFS_PATTERN.test(pathname) ||
    GIT_UPLOAD_PACK_PATTERN.test(pathname) ||
    GIT_RECEIVE_PACK_PATTERN.test(pathname)
  );
}

/**
 * Extract repository ID from Git protocol URL
 */
function extractRepoId(pathname: string): string | null {
  const infoRefsMatch = pathname.match(GIT_INFO_REFS_PATTERN);
  if (infoRefsMatch) return infoRefsMatch[1];

  const uploadPackMatch = pathname.match(GIT_UPLOAD_PACK_PATTERN);
  if (uploadPackMatch) return uploadPackMatch[1];

  const receivePackMatch = pathname.match(GIT_RECEIVE_PACK_PATTERN);
  if (receivePackMatch) return receivePackMatch[1];

  return null;
}

/**
 * Get Durable Object stub for repository (RPC-typed)
 */
function getRepositoryStub(env: Env, repoId: string): DurableObjectStub<GitRepositoryDO> {
  const id = env.GIT_REPOSITORY.idFromName(repoId);
  return env.GIT_REPOSITORY.get(id);
}

/**
 * Handle Git info/refs request
 * Auth is already verified by handleGitProtocolRequest
 */
async function handleInfoRefs(
  request: Request,
  repoStub: DurableObjectStub<GitRepositoryDO>
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const service = url.searchParams.get('service');
    const isReceivePack = service === 'git-receive-pack';

    const isInitialized = await repoStub.isInitialized();

    if (!isInitialized) {
      if (isReceivePack) {
        await repoStub.initialize();

        const capabilities =
          'report-status report-status-v2 delete-refs side-band-64k quiet atomic ofs-delta agent=git/isomorphic-git';
        const zeroOid = '0000000000000000000000000000000000000000';
        const emptyLine = `${zeroOid} capabilities^{}\0${capabilities}\n`;
        const emptyResponse =
          '001f# service=git-receive-pack\n0000' + formatPacketLine(emptyLine) + '0000';

        return new Response(emptyResponse, {
          status: 200,
          headers: {
            'Content-Type': 'application/x-git-receive-pack-advertisement',
            'Cache-Control': 'no-cache',
          },
        });
      } else {
        return new Response('Repository not found', { status: 404 });
      }
    }

    const gitObjects = await repoStub.exportGitObjects();

    const processedObjects = gitObjects.map(obj => ({
      path: obj.path,
      data: Uint8Array.from(atob(obj.data), c => c.charCodeAt(0)),
    }));

    if (processedObjects.length === 0 && !isReceivePack) {
      return new Response('001e# service=git-upload-pack\n0000', {
        status: 200,
        headers: {
          'Content-Type': 'application/x-git-upload-pack-advertisement',
          'Cache-Control': 'no-cache',
        },
      });
    }

    const repoFS = await GitCloneService.buildRepository({
      gitObjects: processedObjects,
    });

    if (isReceivePack) {
      const response = await GitReceivePackService.handleInfoRefs(repoFS);
      return new Response(response, {
        status: 200,
        headers: {
          'Content-Type': 'application/x-git-receive-pack-advertisement',
          'Cache-Control': 'no-cache',
        },
      });
    } else {
      const response = await GitCloneService.handleInfoRefs(repoFS);
      return new Response(response, {
        status: 200,
        headers: {
          'Content-Type': 'application/x-git-upload-pack-advertisement',
          'Cache-Control': 'no-cache',
        },
      });
    }
  } catch (error) {
    logger.error('Git info/refs error', formatError(error));
    return new Response('Internal server error', { status: 500 });
  }
}

/**
 * Handle Git upload-pack request
 * Auth is already verified by handleGitProtocolRequest
 */
async function handleUploadPack(repoStub: DurableObjectStub<GitRepositoryDO>): Promise<Response> {
  try {
    const isInitialized = await repoStub.isInitialized();

    if (!isInitialized) {
      return new Response('Repository not found', { status: 404 });
    }

    const gitObjects = await repoStub.exportGitObjects();

    const processedObjects = gitObjects.map(obj => ({
      path: obj.path,
      data: Uint8Array.from(atob(obj.data), c => c.charCodeAt(0)),
    }));

    if (processedObjects.length === 0) {
      return new Response('No commits to pack', { status: 404 });
    }

    const repoFS = await GitCloneService.buildRepository({
      gitObjects: processedObjects,
    });

    const packfile = await GitCloneService.handleUploadPack(repoFS);
    return new Response(packfile, {
      status: 200,
      headers: {
        'Content-Type': 'application/x-git-upload-pack-result',
        'Cache-Control': 'no-cache',
      },
    });
  } catch (error) {
    logger.error('Git upload-pack error', formatError(error));
    return new Response('Internal server error', { status: 500 });
  }
}

/**
 * Handle Git receive-pack request (push operation)
 * Auth is already verified by handleGitProtocolRequest
 */
async function handleReceivePack(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  repoStub: DurableObjectStub<GitRepositoryDO>,
  repoId: string
): Promise<Response> {
  try {
    const isInitialized = await repoStub.isInitialized();

    if (!isInitialized) {
      await repoStub.initialize();
    }

    const existingObjects = await repoStub.exportGitObjects();

    const processedObjects = existingObjects.map(obj => ({
      path: obj.path,
      data: Uint8Array.from(atob(obj.data), c => c.charCodeAt(0)),
    }));

    const repoFS = await GitCloneService.buildRepository({
      gitObjects: processedObjects,
    });

    const requestData = new Uint8Array(await request.arrayBuffer());

    logger.debug('Received push data', { dataLength: requestData.length });

    const { response, result } = await GitReceivePackService.handleReceivePack(repoFS, requestData);

    logger.info('Push processed', {
      success: result.success,
      refUpdates: result.refUpdates.length,
      hasErrors: result.errors.length > 0,
    });

    // CRITICAL: We must persist objects BEFORE returning success to avoid corrupt state
    if (result.success && result.refUpdates.length > 0) {
      const updatedObjects = GitReceivePackService.exportGitObjects(repoFS);

      let oversizedObject: { path: string; size: number } | null = null as {
        path: string;
        size: number;
      } | null;

      const objectsToSave = updatedObjects.map(obj => {
        const binarySize = obj.data.length;

        if (binarySize > MAX_OBJECT_SIZE && !oversizedObject) {
          oversizedObject = { path: obj.path, size: binarySize };
        }

        return {
          path: obj.path,
          data: Buffer.from(obj.data).toString('base64'),
        };
      });

      // If we found an oversized object, reject the entire push to prevent corruption
      if (oversizedObject) {
        const sizeKB = (oversizedObject.size / 1024).toFixed(2);
        const maxKB = (MAX_OBJECT_SIZE / 1024).toFixed(2);

        const errorMsg =
          `Object exceeds storage limit: ${oversizedObject.path} (${sizeKB}KB, max ${maxKB}KB). ` +
          `Try pushing fewer files at once.`;

        logger.warn('Push rejected: oversized object', {
          path: oversizedObject.path,
          sizeKB,
          maxKB,
        });

        return new Response(`error: ${errorMsg}\n`, {
          status: 413,
          headers: {
            'Content-Type': 'text/plain',
            'Cache-Control': 'no-cache',
          },
        });
      }

      logger.debug('Persisting updated git objects', { objectCount: updatedObjects.length });

      try {
        await repoStub.importGitObjects(objectsToSave);
      } catch (persistError) {
        logger.error('Failed to persist git objects', formatError(persistError));

        const errorMsg =
          persistError instanceof Error ? persistError.message : 'Unknown error persisting objects';

        return new Response(`error: ${errorMsg}\n`, {
          status: 500,
          headers: {
            'Content-Type': 'text/plain',
            'Cache-Control': 'no-cache',
          },
        });
      }

      const mainBranchUpdate = result.refUpdates.find(
        u => u.refName === 'refs/heads/main' || u.refName === 'refs/heads/master'
      );

      if (mainBranchUpdate && mainBranchUpdate.newOid) {
        const commitHash = mainBranchUpdate.newOid;

        if (env.PREVIEW) {
          logger.setTags({ commitHash });
          logger.debug('Triggering preview build', { refName: mainBranchUpdate.refName });

          const previewId = env.PREVIEW.idFromName(repoId);
          const previewStub = env.PREVIEW.get(previewId);

          ctx.waitUntil(
            previewStub.triggerBuild().catch(error => {
              logger.error('Failed to trigger preview build', formatError(error));
            })
          );
        }

        ctx.waitUntil(
          notifyBackendOfPush(env, {
            repoId,
            commitHash,
            branch: mainBranchUpdate.refName.replace('refs/heads/', ''),
          })
        );
      }
    }

    return new Response(response, {
      status: 200,
      headers: {
        'Content-Type': 'application/x-git-receive-pack-result',
        'Cache-Control': 'no-cache',
      },
    });
  } catch (error) {
    logger.error('Git receive-pack error', formatError(error));
    return new Response('Internal server error', { status: 500 });
  }
}

/**
 * Main handler for Git protocol requests
 */
export async function handleGitProtocolRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const url = new URL(request.url);
  const pathname = url.pathname;

  const repoId = extractRepoId(pathname);
  if (!repoId) {
    return new Response('Invalid Git URL', { status: 400 });
  }

  // Get repository stub (needed for legacy auth fallback)
  const repoStub = getRepositoryStub(env, repoId);

  const authResult = await verifyGitAuth(request, repoId, env.GIT_JWT_SECRET, token =>
    repoStub.verifyAuthToken(token)
  );
  if (!authResult.isAuthenticated) {
    return authResult.errorResponse;
  }

  if (GIT_RECEIVE_PACK_PATTERN.test(pathname) && authResult.permission !== 'full') {
    return new Response('Forbidden: Write access required', { status: 403 });
  }

  if (GIT_INFO_REFS_PATTERN.test(pathname)) {
    return handleInfoRefs(request, repoStub);
  } else if (GIT_UPLOAD_PACK_PATTERN.test(pathname)) {
    return handleUploadPack(repoStub);
  } else if (GIT_RECEIVE_PACK_PATTERN.test(pathname)) {
    return handleReceivePack(request, env, ctx, repoStub, repoId);
  }

  return new Response('Not found', { status: 404 });
}
