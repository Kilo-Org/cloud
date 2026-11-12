import {
  GITHUB_LFS_CONTENT_TYPE,
  getGitHubTaskLfsRoute,
  githubLfsBatchSchema,
  githubLfsLockVerificationSchema,
} from '@kilocode/worker-utils/github-task-lfs';

const MAX_JSON_BYTES = 256 * 1024;
const BODY_READ_MS = 10_000;
const forwardedHeaders = [
  'accept',
  'accept-encoding',
  'content-type',
  'user-agent',
  'git-protocol',
  'x-github-api-version',
  'if-none-match',
  'if-modified-since',
];

export function isGitHubTaskDestination(url: URL): boolean {
  const hostname = url.hostname.replace(/\.$/, '');
  return (
    hostname === 'github-cloud.s3.amazonaws.com' ||
    ['github.com', 'githubusercontent.com'].some(
      domain => hostname === domain || hostname.endsWith(`.${domain}`)
    )
  );
}

export type PreparedGitHubTaskRequest = { request: Request; policyBody?: Uint8Array };

async function readChunk(
  reader: ReadableStreamDefaultReader<unknown>
): Promise<{ done: true } | { done: false; value: Uint8Array }> {
  const chunk = await reader.read();
  if (chunk.done) return { done: true };
  if (!(chunk.value instanceof Uint8Array)) throw new Error('Invalid request stream chunk');
  return { done: false, value: chunk.value };
}

/** Strip guest credentials and canonicalize bodies that the broker must inspect. */
export async function prepareGitHubTaskRequest(
  request: Request
): Promise<PreparedGitHubTaskRequest | null> {
  if (
    request.headers.has('content-encoding') ||
    request.headers.has('x-http-method-override') ||
    request.headers.has('x-method-override')
  )
    return null;
  const headers = new Headers();
  for (const name of forwardedHeaders) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  const url = new URL(request.url);
  for (const name of url.searchParams.keys()) {
    if (['access_token', 'token', 'client_secret', '_method'].includes(name.toLowerCase()))
      return null;
  }
  const cleanRequest = (body?: BodyInit) =>
    new Request(request, { headers, ...(body ? { body, duplex: 'half' } : {}) });
  if (!request.body) return { request: cleanRequest() };
  if (url.hostname === 'github.com' && /\/git-(?:upload|receive)-pack$/.test(url.pathname))
    return { request: cleanRequest() };
  const lfs = getGitHubTaskLfsRoute(url);
  if (lfs?.kind === 'upload') return { request: cleanRequest() };
  const reader: ReadableStreamDefaultReader<unknown> = request.body.getReader();
  const deadline = Date.now() + BODY_READ_MS;
  const read = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        readChunk(reader),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('GitHub request body timeout')),
            Math.max(0, deadline - Date.now())
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    if (url.hostname !== 'api.github.com' && lfs?.kind !== 'batch' && lfs?.kind !== 'locks-verify')
      throw new Error('Unsupported GitHub request body');
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const chunk = await read();
      if (chunk.done) break;
      length += chunk.value.length;
      if (length > MAX_JSON_BYTES) throw new Error('GitHub request body exceeds limit');
      chunks.push(chunk.value);
    }
    reader.releaseLock();
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    // Forward the same JSON representation that the policy inspects. Duplicate keys cannot
    // produce different values in the broker and GitHub's parser.
    const parsed: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    );
    if (
      (lfs?.kind === 'batch' || lfs?.kind === 'locks-verify') &&
      (request.method !== 'POST' ||
        request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !==
          GITHUB_LFS_CONTENT_TYPE ||
        !(lfs.kind === 'batch' ? githubLfsBatchSchema : githubLfsLockVerificationSchema).safeParse(
          parsed
        ).success)
    )
      throw new Error('Unsupported GitHub LFS operation');
    const policyBody = new TextEncoder().encode(JSON.stringify(parsed));
    return { request: cleanRequest(policyBody), policyBody };
  } catch {
    try {
      await reader.cancel();
    } catch {
      /* The denial remains authoritative. */
    }
    try {
      reader.releaseLock();
    } catch {
      /* Already released after a complete read. */
    }
    return null;
  }
}
