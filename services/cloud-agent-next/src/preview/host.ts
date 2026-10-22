import { PREVIEW_PORT_MAX, PREVIEW_PORT_MIN } from '../shared/preview-port.js';

export { PREVIEW_PORT_MAX, PREVIEW_PORT_MIN };

const LABEL_PATTERN = /^p([1-9][0-9]{3,4})-([0-9a-f]{32})$/;

export type PreviewHostMatch = {
  label: string;
  port: number;
  cloudAgentSessionId: string;
};

function hexFromSessionId(sessionId: string): string | null {
  const match =
    /^workspace_([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})$/i.exec(
      sessionId
    );
  if (match === null) return null;
  return match.slice(1).join('').toLowerCase();
}

function labelFor(port: string, hex: string): string {
  return `p${port}-${hex}`;
}

export function isValidPreviewPort(port: number): boolean {
  return Number.isInteger(port) && port >= PREVIEW_PORT_MIN && port <= PREVIEW_PORT_MAX;
}

export function previewLabel(cloudAgentSessionId: string, port: number): string | null {
  const hex = hexFromSessionId(cloudAgentSessionId);
  if (hex === null || !isValidPreviewPort(port)) return null;
  return labelFor(String(port), hex);
}

/** The placeholder the web app replaces with a port in `previewHostTemplate`. */
export const PREVIEW_HOST_TEMPLATE_PORT = '{port}';

/**
 * The preview hostname of a session with the port left as a placeholder, so the
 * web app can show preview URLs without its own copy of the label format.
 */
export function previewHostTemplate(cloudAgentSessionId: string, suffix: string): string | null {
  const hex = hexFromSessionId(cloudAgentSessionId);
  if (hex === null) return null;
  return `${labelFor(PREVIEW_HOST_TEMPLATE_PORT, hex)}.${suffix}`;
}

export function parsePreviewLabel(label: string): PreviewHostMatch | null {
  const match = LABEL_PATTERN.exec(label);
  if (match === null) return null;
  const port = Number(match[1]);
  const hex = match[2];
  if (!isValidPreviewPort(port) || hex === undefined) return null;
  const cloudAgentSessionId = `workspace_${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(
    12,
    16
  )}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return { label, port, cloudAgentSessionId };
}

/** The one owner of the on/off switch: an unset or empty suffix disables preview. */
export function isPreviewEnabled(suffix: string | undefined): suffix is string {
  return suffix !== undefined && suffix.length > 0;
}

export function matchPreviewHost(
  hostname: string,
  suffix: string | undefined
): PreviewHostMatch | null {
  if (!isPreviewEnabled(suffix)) return null;
  const expectedSuffix = `.${suffix}`;
  if (!hostname.endsWith(expectedSuffix)) return null;
  const label = hostname.slice(0, hostname.length - expectedSuffix.length);
  if (label.length === 0 || label.includes('.')) return null;
  return parsePreviewLabel(label);
}
