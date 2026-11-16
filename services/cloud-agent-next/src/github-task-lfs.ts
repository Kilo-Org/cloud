import { z } from 'zod';
import { readBoundedStream } from '@kilocode/worker-utils/bounded-stream-reader';
import {
  GITHUB_LFS_CONTENT_TYPE,
  getGitHubTaskLfsRoute,
  githubLfsBatchSchema,
  githubLfsLockVerificationSchema,
  githubLfsDownloadUrl,
  githubLfsUploadUrl,
  githubLfsObjectSchema,
  type GitHubLfsBatch,
  type GitHubLfsObject,
} from '@kilocode/worker-utils/github-task-lfs';
import { uploadGitHubLfsObject } from './github-task-lfs-upload.js';

const actionSchema = z.object({
  href: z.string().max(16_384),
  header: z.record(z.string(), z.string().max(16_384)).optional(),
});
const batchResponseSchema = z.object({
  transfer: z.literal('basic').optional(),
  hash_algo: z.literal('sha256').optional(),
  objects: z
    .array(
      githubLfsObjectSchema.extend({
        authenticated: z.boolean().optional(),
        actions: z
          .object({
            download: actionSchema.optional(),
            upload: actionSchema.optional(),
            verify: actionSchema.optional(),
          })
          .strict()
          .optional(),
        error: z.object({ code: z.number().int().min(400).max(599) }).optional(),
      })
    )
    .max(100),
});
type BatchObject = z.infer<typeof batchResponseSchema>['objects'][number];

/** Storage URLs and headers come only from the authenticated GitHub batch response. */
function storageTarget(action: z.infer<typeof actionSchema>): URL {
  const url = new URL(action.href);
  if (
    url.protocol !== 'https:' ||
    url.port ||
    url.username ||
    url.password ||
    url.hash ||
    ![
      'github-cloud.s3.amazonaws.com',
      'github-cloud.githubusercontent.com',
      'media.githubusercontent.com',
    ].includes(url.hostname) ||
    action.href.includes('\\') ||
    [...action.href].some(
      character => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127
    )
  )
    throw new Error('Unsupported GitHub LFS storage target');
  return url;
}

function downloadTarget(action: z.infer<typeof actionSchema>): URL {
  const url = storageTarget(action);
  for (const name of Object.keys(action.header ?? {})) {
    if (name.toLowerCase() !== 'authorization')
      throw new Error('Unsupported GitHub LFS storage header');
  }
  return url;
}

function uploadTarget(action: z.infer<typeof actionSchema>, object: GitHubLfsObject) {
  const url = storageTarget(action);
  if (url.hostname !== 'github-cloud.s3.amazonaws.com')
    throw new Error('Unsupported GitHub LFS upload target');
  const allowed = new Set([
    'authorization',
    'content-type',
    'content-length',
    'x-amz-date',
    'x-amz-content-sha256',
    'x-amz-security-token',
    'x-amz-server-side-encryption',
  ]);
  const headers = new Headers(action.header);
  for (const name of headers.keys()) {
    if (!allowed.has(name)) throw new Error('Unsupported GitHub LFS upload header');
  }
  if (headers.has('content-length') && headers.get('content-length') !== String(object.size))
    throw new Error('GitHub LFS object size mismatch');
  if (!headers.has('content-type')) headers.set('Content-Type', 'application/octet-stream');
  return { url, headers };
}

function verificationTarget(action: z.infer<typeof actionSchema>, batchUrl: string, oid: string) {
  const prefix = batchUrl.slice(0, -'objects/batch'.length);
  // GitHub answers with its LFS host for the same repository and object.
  const repository = new URL(prefix).pathname.slice(1, -'.git/info/lfs/'.length);
  const allowed = [
    `${prefix}verify`,
    `${prefix}objects/${oid}/verify`,
    `https://lfs.github.com/${repository}/objects/${oid}/verify`,
  ].map(href => href.toLowerCase());
  if (!allowed.includes(action.href.toLowerCase()))
    throw new Error('Unsupported GitHub LFS verification target');
  if (
    Object.keys(action.header ?? {}).some(
      name => !['authorization', 'accept'].includes(name.toLowerCase())
    )
  )
    throw new Error('Unsupported GitHub LFS verification header');
  return action.href;
}

async function readJson(response: Response): Promise<unknown> {
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error('GitHub LFS response unavailable');
  }
  const stream: ReadableStream<unknown> = response.body;
  const bytes = await readBoundedStream(
    stream.pipeThrough(
      new TransformStream<unknown, Uint8Array>({
        transform(chunk, controller) {
          if (!(chunk instanceof Uint8Array)) throw new Error('Invalid GitHub LFS response stream');
          controller.enqueue(chunk);
        },
      })
    ),
    1024 * 1024
  );
  if (!bytes.ok) throw new Error('GitHub LFS response exceeds limit');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.bytes));
}

function githubHeaders(authorization: string | null) {
  return {
    ...(authorization === null ? {} : { Authorization: authorization }),
    Accept: GITHUB_LFS_CONTENT_TYPE,
    'Content-Type': GITHUB_LFS_CONTENT_TYPE,
    'User-Agent': 'Kilo-Cloud-Agent',
  };
}

async function readBatch(
  batchUrl: string,
  batch: GitHubLfsBatch,
  authorization: string | null
): Promise<BatchObject[]> {
  const response = await fetch(batchUrl, {
    method: 'POST',
    headers: githubHeaders(authorization),
    body: JSON.stringify({ ...batch, transfers: ['basic'] }),
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
  });
  const result = batchResponseSchema.parse(await readJson(response));
  const requested = new Map(batch.objects.map(object => [object.oid, object.size]));
  if (result.objects.length !== requested.size) throw new Error('GitHub LFS batch object mismatch');
  for (const object of result.objects) {
    if (requested.get(object.oid) !== object.size || (object.error && object.actions))
      throw new Error('GitHub LFS batch object mismatch');
    requested.delete(object.oid);
    if (object.error) continue;
    const actions = object.actions;
    if (batch.operation === 'download') {
      if (!actions?.download || actions.upload || actions.verify)
        throw new Error('GitHub LFS download action mismatch');
      downloadTarget(actions.download);
    } else if (actions) {
      if (!actions.upload || actions.download) throw new Error('GitHub LFS upload action mismatch');
      uploadTarget(actions.upload, object);
      if (actions.verify) verificationTarget(actions.verify, batchUrl, object.oid);
    }
  }
  return result.objects;
}

function objectError(object: GitHubLfsObject, status: number) {
  return {
    ...object,
    error: { code: status, message: 'GitHub LFS object unavailable' },
  };
}

const lockSchema = z.object({
  id: z.string().min(1).max(1024),
  path: z.string().min(1).max(4096),
  locked_at: z.string().max(128),
  owner: z.object({ name: z.string().max(1024) }).optional(),
});
const locksSchema = z.object({
  ours: z.array(lockSchema).max(1000),
  theirs: z.array(lockSchema).max(1000),
  next_cursor: z.string().max(1024).optional(),
});
const responseHeaders = { 'Content-Type': GITHUB_LFS_CONTENT_TYPE, 'Cache-Control': 'no-store' };

async function verifyLocks(request: Request, body: unknown, authorization: string | null) {
  const verification = githubLfsLockVerificationSchema.parse(body);
  const response = await fetch(request.url, {
    method: 'POST',
    headers: githubHeaders(authorization),
    body: JSON.stringify(verification),
    redirect: 'manual',
    signal: AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]),
  });
  return Response.json(locksSchema.parse(await readJson(response)), { headers: responseHeaders });
}

async function verifyUpload(
  action: z.infer<typeof actionSchema>,
  batchUrl: string,
  object: GitHubLfsObject,
  authorization: string | null
) {
  const url = verificationTarget(action, batchUrl, object.oid);
  const headers = new Headers(githubHeaders(authorization));
  for (const [name, value] of Object.entries(action.header ?? {})) headers.set(name, value);
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ oid: object.oid, size: object.size }),
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
  });
  await response.body?.cancel();
  if (!response.ok) throw new Error('GitHub LFS verification unavailable');
}

async function downloadObject(object: BatchObject): Promise<Response> {
  if (object.error)
    return new Response('GitHub LFS object unavailable', { status: object.error.code });
  const action = object.actions?.download;
  if (!action) throw new Error('GitHub LFS download unavailable');
  const url = downloadTarget(action);
  const headers = new Headers(action.header);
  headers.set('Accept-Encoding', 'identity');
  const response = await fetch(url, {
    headers,
    redirect: 'manual',
    signal: AbortSignal.timeout(120_000),
  });
  if (response.status !== 200 || !response.body) {
    await response.body?.cancel();
    throw new Error('GitHub LFS storage unavailable');
  }
  let received = 0;
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        received += chunk.byteLength;
        if (received > object.size) throw new Error('GitHub LFS object size mismatch');
        controller.enqueue(chunk);
      },
      flush() {
        if (received !== object.size) throw new Error('GitHub LFS object size mismatch');
      },
    })
  );
  // Do not expose storage credentials through redirects, cookies, or arbitrary response headers.
  return new Response(body, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(object.size),
      'Cache-Control': 'no-store',
    },
  });
}

/** Call only after the broker authorizes this exact request and current allocation. */
export async function forwardGitHubTaskLfs(input: {
  request: Request;
  policyBody?: Uint8Array;
  authorization: string | null;
  capability: string;
}): Promise<Response> {
  const route = getGitHubTaskLfsRoute(new URL(input.request.url));
  if (!route) throw new Error('Invalid GitHub LFS route');
  if (route.kind === 'upload') {
    const [object] = await readBatch(
      route.batchUrl,
      {
        operation: 'upload',
        ref: { name: route.ref },
        objects: [route.object],
      },
      input.authorization
    );
    if (!object) throw new Error('GitHub LFS object unavailable');
    if (object.error) {
      await input.request.body?.cancel();
      return new Response('GitHub LFS object unavailable', { status: object.error.code });
    }
    await uploadGitHubLfsObject(
      input.request,
      route.object,
      object.actions?.upload ? uploadTarget(object.actions.upload, object) : undefined
    );
    if (object.actions?.verify)
      await verifyUpload(object.actions.verify, route.batchUrl, object, input.authorization);
    return new Response(null, { headers: { 'Cache-Control': 'no-store' } });
  }
  if (route.kind === 'download') {
    const objects = await readBatch(
      route.batchUrl,
      {
        operation: 'download',
        objects: [route.object],
      },
      input.authorization
    );
    const object = objects[0];
    if (!object) throw new Error('GitHub LFS object unavailable');
    return downloadObject(object);
  }
  if (route.kind === 'locks-verify')
    return verifyLocks(
      input.request,
      JSON.parse(new TextDecoder().decode(input.policyBody)),
      input.authorization
    );
  const batch = githubLfsBatchSchema.parse(JSON.parse(new TextDecoder().decode(input.policyBody)));
  const objects = await readBatch(route.batchUrl, batch, input.authorization);
  return Response.json(
    {
      transfer: 'basic',
      objects: objects.map(object =>
        object.error
          ? objectError({ oid: object.oid, size: object.size }, object.error.code)
          : {
              oid: object.oid,
              size: object.size,
              authenticated: true,
              ...(object.actions
                ? {
                    actions: {
                      [batch.operation]: {
                        href:
                          batch.operation === 'download'
                            ? githubLfsDownloadUrl(route.batchUrl, object)
                            : githubLfsUploadUrl(route.batchUrl, object, batch.ref.name),
                        header: { Authorization: `Bearer ${input.capability}` },
                      },
                    },
                  }
                : {}),
            }
      ),
    },
    {
      headers: responseHeaders,
    }
  );
}
