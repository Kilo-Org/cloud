import 'server-only';
import { TRPCError } from '@trpc/server';
import { getEnvVariable } from '@kilocode/web-shared/lib/dotenvx';

const PREVIEW_OPEN_PATH = '/preview/open';

/** The browser-facing Worker origin, with the WebSocket scheme mapped to HTTP. */
function browserWorkerUrl(): URL {
  const workerUrl = getEnvVariable('NEXT_PUBLIC_CLOUD_AGENT_NEXT_WS_URL').trim();
  if (!workerUrl) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Preview is not configured' });
  }
  const url = new URL(workerUrl);
  if (url.protocol === 'wss:') url.protocol = 'https:';
  else if (url.protocol === 'ws:') url.protocol = 'http:';
  return url;
}

/**
 * The browser URL of the Worker hop that redirects to the preview host. The
 * Worker owns the preview suffix and the hostname label; the web app only names
 * the browser-facing Worker origin. The Worker validates `path`.
 */
export function buildPreviewOpenUrl(ticket: string, path?: string): string {
  const url = new URL(PREVIEW_OPEN_PATH, browserWorkerUrl());
  const params = new URLSearchParams({ ticket });
  if (path !== undefined) params.set('path', path);
  url.search = params.toString();
  return url.toString();
}

/**
 * The preview origin with the Worker's `{port}` placeholder still in the host.
 * The open hop keeps the scheme and port of the browser-facing Worker URL, so
 * this template does the same.
 */
export function buildPreviewUrlTemplate(hostTemplate: string): string {
  const worker = browserWorkerUrl();
  return `${worker.protocol}//${hostTemplate}${worker.port ? `:${worker.port}` : ''}`;
}
