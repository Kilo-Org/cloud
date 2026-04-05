'use client';

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
import { useDrawerStack, type ResourceRef } from './DrawerStack';
import { getToken } from '@/lib/gastown/trpc';

/**
 * Tracks dashboard navigation context and stores it on the TownDO so the
 * mayor has awareness of what the user is viewing.
 *
 * Phase 1: Stores context as an in-memory XML string on the TownDO via
 * a lightweight POST. The TownDO injects this into the mayor's prompt
 * when starting a new session.
 */

type ActivityEntry = {
  timestamp: string;
  action: 'page_view' | 'object_view';
  page?: string;
  objectType?: string;
  objectId?: string;
};

const MAX_ACTIVITY_ENTRIES = 10;
const SYNC_DEBOUNCE_MS = 2_000;
const SYNC_RETRY_MS = 10_000;

/** Derive a human-readable page label from the pathname. */
function pageFromPathname(pathname: string, townId: string): string {
  const base = `/gastown/${townId}`;
  if (pathname === base) return 'town-overview';
  const suffix = pathname.slice(base.length + 1);
  if (suffix.startsWith('rigs/')) {
    const rigId = suffix.split('/')[1];
    return rigId ? `rig-detail (rigId: ${rigId})` : 'rigs';
  }
  if (suffix.startsWith('beads')) return 'beads';
  if (suffix.startsWith('agents')) return 'agents';
  if (suffix.startsWith('merges')) return 'merges';
  if (suffix.startsWith('mail')) return 'mail';
  if (suffix.startsWith('observability')) return 'observability';
  if (suffix.startsWith('settings')) return 'settings';
  return suffix || 'town-overview';
}

function drawerResourceToXml(resource: ResourceRef): string {
  switch (resource.type) {
    case 'bead':
      return `<viewing-object type="bead" id="${resource.beadId}" rig-id="${resource.rigId}" />`;
    case 'agent':
      return `<viewing-object type="agent" id="${resource.agentId}" rig-id="${resource.rigId}" />`;
    case 'convoy':
      return `<viewing-object type="convoy" id="${resource.convoyId}" />`;
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
  lines.push(`  <current-view page="${page}" />`);

  if (drawerResource) {
    lines.push(`  ${drawerResourceToXml(drawerResource)}`);
  }

  if (recentActivity.length > 0) {
    lines.push('  <recent-actions>');
    for (const entry of recentActivity) {
      const ago = formatAgo(entry.timestamp);
      if (entry.action === 'page_view') {
        lines.push(`    - ${ago}: Navigated to ${entry.page ?? 'unknown'}`);
      } else if (entry.objectType) {
        lines.push(`    - ${ago}: Viewed ${entry.objectType} ${entry.objectId ?? ''}`);
      }
    }
    lines.push('  </recent-actions>');
  }

  lines.push('</user-context>');
  return lines.join('\n');
}

/**
 * Hook that tracks the user's dashboard navigation and syncs the context
 * XML to the TownDO via a lightweight POST. The TownDO stores it in
 * memory and injects it when the mayor session starts or restarts.
 */
export function useGastownUiContext(townId: string, gastownUrl: string): string {
  const pathname = usePathname();
  const { stack } = useDrawerStack();
  const activityRef = useRef<ActivityEntry[]>([]);
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSyncedRef = useRef<string>('');
  const prevPathnameRef = useRef<string>(pathname);
  const prevDrawerRef = useRef<ResourceRef | null>(null);

  const topDrawer = stack.length > 0 ? stack[stack.length - 1].resource : null;

  // Track activity changes synchronously during render so the XML
  // built below always includes the current navigation state.
  if (pathname !== prevPathnameRef.current) {
    prevPathnameRef.current = pathname;
    const page = pageFromPathname(pathname, townId);
    activityRef.current = [
      { timestamp: new Date().toISOString(), action: 'page_view', page },
      ...activityRef.current.slice(0, MAX_ACTIVITY_ENTRIES - 1),
    ];
  }

  if (topDrawer !== prevDrawerRef.current && topDrawer) {
    prevDrawerRef.current = topDrawer;
    activityRef.current = [
      {
        timestamp: new Date().toISOString(),
        action: 'object_view',
        objectType: topDrawer.type,
        objectId:
          'beadId' in topDrawer
            ? topDrawer.beadId
            : 'agentId' in topDrawer
              ? topDrawer.agentId
              : 'convoyId' in topDrawer
                ? topDrawer.convoyId
                : undefined,
      },
      ...activityRef.current.slice(0, MAX_ACTIVITY_ENTRIES - 1),
    ];
  } else if (!topDrawer) {
    prevDrawerRef.current = null;
  }

  // Build current context XML (includes the just-recorded activity)
  const page = pageFromPathname(pathname, townId);
  const contextXml = buildContextXml(page, topDrawer, activityRef.current);

  // Sync context XML to TownDO. Retries on failure so the mayor
  // doesn't permanently lose context after a transient error.
  useEffect(() => {
    if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current);

    function doSync() {
      if (contextXml === lastSyncedRef.current) return;
      const xml = contextXml;

      getToken()
        .then(token =>
          fetch(`${gastownUrl}/api/towns/${townId}/mayor/dashboard-context`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ context: xml }),
          })
        )
        .then(resp => {
          if (resp.ok) {
            lastSyncedRef.current = xml;
          } else {
            // Schedule a retry — the effect won't re-run since contextXml
            // hasn't changed, so we need an explicit retry timer.
            retryTimerRef.current = setTimeout(doSync, SYNC_RETRY_MS);
          }
        })
        .catch(() => {
          retryTimerRef.current = setTimeout(doSync, SYNC_RETRY_MS);
        });
    }

    syncTimerRef.current = setTimeout(doSync, SYNC_DEBOUNCE_MS);

    return () => {
      if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    };
  }, [contextXml, townId, gastownUrl]);

  return contextXml;
}
