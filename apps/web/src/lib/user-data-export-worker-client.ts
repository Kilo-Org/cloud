import 'server-only';

import { z } from 'zod';
import { INTERNAL_API_SECRET, USER_DATA_EXPORT_WORKER_URL } from '@/lib/config.server';

const LOCAL_EXPORT_WORKER_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const DEPLOYED_EXPORT_WORKER_HOSTS = new Set([
  'user-data-export.kiloapps.io',
  'user-data-export-staging.kiloapps.io',
]);
const REQUEST_TIMEOUT_MS = 10_000;

type DispatchWorkerResponse =
  | { kind: 'accepted' }
  | { kind: 'unavailable'; reason: 'not_configured' | 'not_implemented' };

type DownloadWorkerResponse =
  | { kind: 'available'; downloadUrl: string; expiresAt: string }
  | { kind: 'unavailable'; reason: 'not_configured' | 'not_implemented' };

const DownloadResponseSchema = z.object({
  downloadUrl: z.string().url().startsWith('https://'),
  expiresAt: z.string().datetime(),
});

function exportWorkerUrl(value: string | undefined): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const isLocal = url.protocol === 'http:' && LOCAL_EXPORT_WORKER_HOSTS.has(url.hostname);
    const isDeployed = url.protocol === 'https:' && DEPLOYED_EXPORT_WORKER_HOSTS.has(url.hostname);
    return isLocal || isDeployed ? url : null;
  } catch {
    return null;
  }
}

async function postExportWorker(
  path: string,
  body: object,
  fetchImpl: typeof fetch = fetch
): Promise<Response | null> {
  const baseUrl = exportWorkerUrl(USER_DATA_EXPORT_WORKER_URL);
  if (!baseUrl || !INTERNAL_API_SECRET) return null;

  const url = new URL(path, baseUrl);
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'content-type': 'application/json',
        'x-internal-api-key': INTERNAL_API_SECRET,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return response;
  } catch {
    return null;
  }
}

export async function dispatchUserDataExport(input: {
  exportId: string;
  generation: number;
}): Promise<DispatchWorkerResponse> {
  const response = await postExportWorker('/internal/exports/dispatch', {
    version: 1,
    operation: 'generate',
    exportId: input.exportId,
    generation: input.generation,
  });
  return response?.ok
    ? { kind: 'accepted' }
    : {
        kind: 'unavailable',
        reason: response?.status === 501 ? 'not_implemented' : 'not_configured',
      };
}

export async function requestUserDataExportDownload(input: {
  exportId: string;
  kiloUserId: string;
}): Promise<DownloadWorkerResponse> {
  const response = await postExportWorker('/internal/exports/download', { version: 1, ...input });
  if (!response) return { kind: 'unavailable', reason: 'not_configured' };
  if (response.status === 501) return { kind: 'unavailable', reason: 'not_implemented' };
  if (!response.ok) return { kind: 'unavailable', reason: 'not_configured' };
  const parsed = DownloadResponseSchema.safeParse(await response.json().catch(() => null));
  return parsed.success
    ? { kind: 'available', ...parsed.data }
    : { kind: 'unavailable', reason: 'not_configured' };
}

export const __test__ = { exportWorkerUrl, postExportWorker };
