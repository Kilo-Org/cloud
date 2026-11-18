import { PREVIEW_PORT_MAX, PREVIEW_PORT_MIN } from '../shared/preview-port.js';

export { PREVIEW_PORT_MAX, PREVIEW_PORT_MIN };

const LABEL_PATTERN = /^([pw])([1-9][0-9]{3,4})-([0-9a-f]{32})$/;

const UUID_HEX_PATTERN = '([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})';

const TARGET_PATTERNS = {
  p: new RegExp(`^workspace_${UUID_HEX_PATTERN}$`, 'i'),
  w: new RegExp(`^worktree_${UUID_HEX_PATTERN}$`, 'i'),
} as const;

export type PreviewHostTarget = { worktreeId: string } | { cloudAgentSessionId: string };

export type PreviewHostMatch = PreviewHostTarget & {
  label: string;
  port: number;
};

type TargetHex = {
  prefix: 'p' | 'w';
  hex: string;
};

function hexFromTarget(targetId: string): TargetHex | null {
  for (const prefix of ['p', 'w'] as const) {
    const match = TARGET_PATTERNS[prefix].exec(targetId);
    if (match === null) continue;
    return { prefix, hex: match.slice(1).join('').toLowerCase() };
  }
  return null;
}

function labelFor(prefix: 'p' | 'w', port: string, hex: string): string {
  return `${prefix}${port}-${hex}`;
}

function targetFromHex(prefix: 'p' | 'w', hex: string): PreviewHostTarget {
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
    16,
    20
  )}-${hex.slice(20)}`;
  return prefix === 'p'
    ? { cloudAgentSessionId: `workspace_${uuid}` }
    : { worktreeId: `worktree_${uuid}` };
}

type PreviewTargetIds = {
  worktreeId?: string;
  cloudAgentSessionId?: string;
};

export function previewTargetId(target: PreviewTargetIds): string | null {
  if (target.worktreeId !== undefined) return target.worktreeId;
  if (target.cloudAgentSessionId !== undefined) return target.cloudAgentSessionId;
  return null;
}

export function isValidPreviewPort(port: number): boolean {
  return Number.isInteger(port) && port >= PREVIEW_PORT_MIN && port <= PREVIEW_PORT_MAX;
}

export function previewLabel(targetId: string, port: number): string | null {
  const target = hexFromTarget(targetId);
  if (target === null || !isValidPreviewPort(port)) return null;
  return labelFor(target.prefix, String(port), target.hex);
}

/** The placeholder the web app replaces with a port in `previewHostTemplate`. */
export const PREVIEW_HOST_TEMPLATE_PORT = '{port}';

/**
 * The preview hostname of a target with the port left as a placeholder, so the
 * web app can show preview URLs without its own copy of the label format.
 */
export function previewHostTemplate(targetId: string, suffix: string): string | null {
  const target = hexFromTarget(targetId);
  if (target === null) return null;
  return `${labelFor(target.prefix, PREVIEW_HOST_TEMPLATE_PORT, target.hex)}.${suffix}`;
}

export function parsePreviewLabel(label: string): PreviewHostMatch | null {
  const match = LABEL_PATTERN.exec(label);
  if (match === null) return null;
  const prefix = match[1];
  const port = Number(match[2]);
  const hex = match[3];
  if ((prefix !== 'p' && prefix !== 'w') || !isValidPreviewPort(port) || hex === undefined) {
    return null;
  }
  return { label, port, ...targetFromHex(prefix, hex) };
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
