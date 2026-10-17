import type { ResourceRef } from './DrawerStack';

/**
 * Builds the `<user-context>` XML document that describes what the user is
 * looking at on the town dashboard. The document is POSTed to the gastown
 * worker and injected into the mayor's prompt, so every value placed in it is
 * treated as untrusted text: the page label comes from a fixed vocabulary and
 * all interpolated values are XML-escaped.
 */

export type ActivityEntry = {
  timestamp: string;
  action: 'page_view' | 'object_view';
  page?: string;
  objectType?: string;
  objectId?: string;
};

/** Page labels the dashboard can report, besides the root and rig detail views. */
const SECTION_PAGES: Record<string, true> = {
  beads: true,
  agents: true,
  merges: true,
  mail: true,
  observability: true,
  settings: true,
};

/** Label for a route that is not one of the known dashboard pages. */
const UNKNOWN_PAGE = 'other';

/** Rig ids are server-generated UUIDs; anything else is not a rig id. */
const RIG_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const XML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

// Control characters that are invalid in XML 1.0 and have no place in a
// prompt-context document.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** Escape a value for use inside the context document's element text or attributes. */
export function escapeXml(value: string): string {
  return value.replace(CONTROL_CHARS, '').replace(/[&<>"']/g, char => XML_ESCAPES[char] ?? char);
}

/**
 * Derive a page label from the pathname. Returns a label from a fixed
 * vocabulary — never path text — because the label ends up in the mayor's
 * prompt context.
 */
export function pageFromPathname(pathname: string, townId: string): string {
  const marker = `/gastown/${townId}`;
  const markerIndex = pathname.indexOf(marker);
  if (markerIndex === -1) return UNKNOWN_PAGE;

  const segments = pathname
    .slice(markerIndex + marker.length)
    .split('/')
    .filter(segment => segment.length > 0);

  if (segments.length === 0) return 'town-overview';

  const [section, rigId] = segments;
  if (section === 'rigs') {
    return rigId && RIG_ID_PATTERN.test(rigId) ? `rig-detail (rigId: ${rigId})` : 'rigs';
  }
  // Own properties only: inherited names such as `toString` are not page labels.
  return Object.hasOwn(SECTION_PAGES, section) ? section : UNKNOWN_PAGE;
}

function drawerResourceToXml(resource: ResourceRef): string {
  switch (resource.type) {
    case 'bead':
      return `<viewing-object type="bead" id="${escapeXml(resource.beadId)}" rig-id="${escapeXml(resource.rigId)}" />`;
    case 'agent':
      return `<viewing-object type="agent" id="${escapeXml(resource.agentId)}" rig-id="${escapeXml(resource.rigId)}" />`;
    case 'convoy':
      return `<viewing-object type="convoy" id="${escapeXml(resource.convoyId)}" />`;
    case 'event':
      return `<viewing-object type="event" />`;
  }
}

function formatAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3600_000) return `${Math.round(diff / 60_000)}m ago`;
  return `${Math.round(diff / 3600_000)}h ago`;
}

export function buildContextXml(
  page: string,
  drawerResource: ResourceRef | null,
  recentActivity: ActivityEntry[]
): string {
  const lines: string[] = ['<user-context>'];
  lines.push(`  <current-view page="${escapeXml(page)}" />`);

  if (drawerResource) {
    lines.push(`  ${drawerResourceToXml(drawerResource)}`);
  }

  if (recentActivity.length > 0) {
    lines.push('  <recent-actions>');
    for (const entry of recentActivity) {
      const ago = formatAgo(entry.timestamp);
      if (entry.action === 'page_view') {
        lines.push(`    - ${ago}: Navigated to ${escapeXml(entry.page ?? 'unknown')}`);
      } else if (entry.objectType) {
        lines.push(
          `    - ${ago}: Viewed ${escapeXml(entry.objectType)} ${escapeXml(entry.objectId ?? '')}`
        );
      }
    }
    lines.push('  </recent-actions>');
  }

  lines.push('</user-context>');
  return lines.join('\n');
}
