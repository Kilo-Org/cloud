import { isPreviewLoopbackHostname } from '../../../../../services/cloud-agent-next/src/shared/preview-loopback';
import {
  PREVIEW_PORT_MAX,
  PREVIEW_PORT_MIN,
} from '../../../../../services/cloud-agent-next/src/shared/preview-port';

/** The placeholder in the preview URL template from `getPreviewOptions`. */
const PREVIEW_URL_TEMPLATE_PORT = '{port}';
const PREVIEW_PATH_MAX_LENGTH = 2048;

export type PreviewLinkTarget = { port: number; path: string };

/**
 * A link that the agent wrote for a server inside its sandbox, such as
 * `http://localhost:5173/app`. In a cloud session that address means the
 * sandbox, not the viewer's machine. Returns null for every other link.
 */
export function parsePreviewLinkTarget(href: string | undefined): PreviewLinkTarget | null {
  if (!href) return null;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!isPreviewLoopbackHostname(url.hostname) || url.username || url.password) return null;
  const port = Number(url.port);
  if (
    url.port === '' ||
    !Number.isInteger(port) ||
    port < PREVIEW_PORT_MIN ||
    port > PREVIEW_PORT_MAX
  ) {
    return null;
  }
  const path = `${url.pathname}${url.search}${url.hash}`;
  return { port, path: path.length > PREVIEW_PATH_MAX_LENGTH ? '/' : path };
}

export function previewLinkUrl(urlTemplate: string, target: PreviewLinkTarget): string {
  return `${urlTemplate.replace(PREVIEW_URL_TEMPLATE_PORT, String(target.port))}${target.path}`;
}
