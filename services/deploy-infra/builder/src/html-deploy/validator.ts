import type { DeploymentFile } from '../types';
import { getMimeType } from '../utils';

export const MAX_TOTAL_BYTES = 10 * 1024 * 1024;

export function getUploadFormat(contentType: string): 'html' | 'multipart' | null {
  const mediaType = contentType.split(';', 1)[0]?.trim().toLowerCase();
  if (mediaType === 'text/html') return 'html';
  if (mediaType === 'multipart/form-data') return 'multipart';
  return null;
}

const ALLOWED_EXTENSIONS = new Set([
  'html',
  'htm',
  'xhtml',
  'css',
  'js',
  'mjs',
  'cjs',
  'json',
  'xml',
  'yaml',
  'yml',
  'toml',
  'csv',
  'txt',
  'md',
  'markdown',
  'jpg',
  'jpeg',
  'png',
  'gif',
  'svg',
  'webp',
  'avif',
  'ico',
  'bmp',
  'tiff',
  'tif',
  'woff',
  'woff2',
  'ttf',
  'otf',
  'eot',
  'mp4',
  'webm',
  'mp3',
  'wav',
  'ogg',
  'oga',
  'ogv',
  'wasm',
  'map',
  'pdf',
]);

function sizeLimitError(): Error {
  return new Error(`Request exceeds the ${MAX_TOTAL_BYTES / (1024 * 1024)} MB limit`);
}

async function readLimitedBody(request: Request): Promise<Buffer> {
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null) {
    const declaredBytes = Number(contentLength);
    if (Number.isFinite(declaredBytes) && declaredBytes > MAX_TOTAL_BYTES) {
      throw sizeLimitError();
    }
  }

  if (!request.body) {
    return Buffer.alloc(0);
  }

  const reader = request.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    totalBytes += value.byteLength;
    if (totalBytes > MAX_TOTAL_BYTES) {
      await reader.cancel();
      throw sizeLimitError();
    }
    chunks.push(Buffer.from(value));
  }

  return Buffer.concat(chunks, totalBytes);
}

export function validateStaticAssets(assets: DeploymentFile[]): string | null {
  if (!assets.some(asset => asset.path === 'index.html')) {
    return 'index.html is required at the root';
  }

  for (const file of assets) {
    const ext = file.path.split('.').pop()?.toLowerCase();
    if (ext && !ALLOWED_EXTENSIONS.has(ext)) {
      return `File "${file.path}" has a disallowed extension (.${ext}) - only static files are allowed`;
    }
  }

  return null;
}

export async function parseHtmlFile(request: Request): Promise<DeploymentFile[]> {
  const content = await readLimitedBody(request);
  if (content.byteLength === 0) {
    throw new Error('Empty body');
  }

  return [{ path: 'index.html', content, mimeType: 'text/html' }];
}

export async function parseMultipartFiles(request: Request): Promise<DeploymentFile[]> {
  const body = await readLimitedBody(request);
  const bufferedRequest = new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: Uint8Array.from(body).buffer,
  });
  const formData = await bufferedRequest.formData();
  const files: DeploymentFile[] = [];
  const normalizedPaths = new Set<string>();
  // The default Workers types omit file entries even though multipart FormData returns them.
  const entries = formData.entries() as IterableIterator<[string, File | string]>;

  for (const [key, value] of entries) {
    if (typeof value === 'string') continue;

    const normalizedPath = key.replace(/\\/g, '/');
    if (normalizedPath.includes('..') || normalizedPath.startsWith('/')) {
      throw new Error(`Invalid file path: ${key}`);
    }
    if (normalizedPath.split('/').some(segment => segment.startsWith('.'))) {
      throw new Error(`Hidden files are not allowed: "${key}"`);
    }
    if (normalizedPaths.has(normalizedPath)) {
      throw new Error(`Duplicate file path: "${normalizedPath}"`);
    }
    normalizedPaths.add(normalizedPath);

    files.push({
      path: normalizedPath,
      content: Buffer.from(await value.arrayBuffer()),
      mimeType: getMimeType(normalizedPath),
    });
  }

  return files;
}

export function parseTtlHeader(
  header: string | null,
  defaults: { defaultTtl: number; maxTtl: number }
): number {
  if (header === null) return defaults.defaultTtl;
  if (!/^\d+$/.test(header)) {
    throw new Error('X-Expires-In must be a positive base-10 integer');
  }

  const seconds = Number(header);
  if (seconds <= 0) {
    throw new Error('X-Expires-In must be a positive base-10 integer');
  }
  return Math.min(seconds, defaults.maxTtl);
}
