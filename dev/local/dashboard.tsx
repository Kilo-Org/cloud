import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { render, Box, Text, useInput, useApp, useStdout } from 'ink';
import { execSync } from 'node:child_process';
import {
  getService,
  getGroups,
  getGroupServiceNames,
  getAlwaysOnGroupIds,
  resolveGroups,
  resolveGroupTransitiveDeps,
} from './services';
import type { ServiceGroup } from './services';
import { getSessionName, killSession } from './tmux';
import {
  probePort,
  startServiceInTmux,
  stopServiceInTmux,
  restartServiceInTmux,
  showServiceInTmux,
  showGroupInTmux,
} from './runner';

// ---------------------------------------------------------------------------
// Types & constants
// ---------------------------------------------------------------------------

type ServiceStatus = 'up' | 'down' | 'starting';
type GroupStatus = 'on' | 'off' | 'partial';

type SidebarItem =
  | { kind: 'group'; groupId: string }
  | { kind: 'service'; name: string; groupId: string }
  | { kind: 'spacer' };

/**
 * Tracks what is currently shown in the right panel of window 0.
 * - { kind: "service", name } — single service pane
 * - { kind: "group", groupId, serviceNames } — multi-pane group view
 * - null — nothing shown yet
 */
type ViewedTarget =
  | { kind: 'service'; name: string }
  | { kind: 'group'; groupId: string; serviceNames: string[] }
  | null;

const REFRESH_MS = 2000;
const STARTING_GRACE_MS = 30_000;
const START_DELAY_MS = 300;
const SIDEBAR_WIDTH = 40;

// Resolved once at module level
const sessionName = getSessionName();
const alwaysOnGroupIds = new Set(getAlwaysOnGroupIds());
const groupsById = new Map(getGroups().map(g => [g.id, g]));

// ---------------------------------------------------------------------------
// Sidebar item list builder
// ---------------------------------------------------------------------------

function buildSidebarItems(enabledGroups: Set<string>): SidebarItem[] {
  const items: SidebarItem[] = [];
  for (const group of getGroups()) {
    if (group.sectionBreakBefore) {
      items.push({ kind: 'spacer' });
    }
    items.push({ kind: 'group', groupId: group.id });
    if (enabledGroups.has(group.id)) {
      for (const name of getGroupServiceNames(group.id)) {
        items.push({ kind: 'service', name, groupId: group.id });
      }
    }
  }
  return items;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeGroupStatus(groupId: string, statuses: Map<string, ServiceStatus>): GroupStatus {
  const members = getGroupServiceNames(groupId);
  if (members.length === 0) return 'off';
  let upCount = 0;
  for (const name of members) {
    if (statuses.get(name) === 'up') upCount++;
  }
  if (upCount === members.length) return 'on';
  if (upCount === 0) return 'off';
  return 'partial';
}

function currentViewedEncoded(viewed: ViewedTarget): string {
  if (!viewed) return '';
  if (viewed.kind === 'service') return viewed.name;
  return viewed.serviceNames.join(',');
}

function isGroupView(
  viewed: ViewedTarget
): viewed is { kind: 'group'; groupId: string; serviceNames: string[] } {
  return viewed !== null && viewed.kind === 'group';
}

function doShowService(serviceName: string, viewedRef: React.MutableRefObject<ViewedTarget>): void {
  const current = viewedRef.current;
  const currentIsGroup = isGroupView(current);
  const newViewed = showServiceInTmux(
    sessionName,
    serviceName,
    currentViewedEncoded(current),
    currentIsGroup
  );
  viewedRef.current = newViewed !== '' ? { kind: 'service', name: newViewed } : null;
}

function doShowGroup(
  groupId: string,
  runningServiceNames: string[],
  viewedRef: React.MutableRefObject<ViewedTarget>
): void {
  if (runningServiceNames.length === 0) return;
  const current = viewedRef.current;
  const currentIsGroup = isGroupView(current);
  const result = showGroupInTmux(
    sessionName,
    runningServiceNames,
    currentViewedEncoded(current),
    currentIsGroup
  );
  if (result !== currentViewedEncoded(current)) {
    viewedRef.current = { kind: 'group', groupId, serviceNames: runningServiceNames };
  }
}

function doCleanup(): void {
  try {
    execSync('docker compose -f dev/docker-compose.yml down', { stdio: 'ignore' });
  } catch {
    // ignore
  }
  try {
    killSession(sessionName);
  } catch {
    // ignore
  }
}

/** Find the first running service from a list to swap into view */
function findViewableService(
  serviceNames: string[],
  runningServices: Set<string>,
  exclude?: string
): string | undefined {
  return serviceNames.find(name => runningServices.has(name) && name !== exclude);
}

/** True if the given service name is currently shown in the right panel */
function isServiceViewed(name: string, viewed: ViewedTarget): boolean {
  if (!viewed) return false;
  if (viewed.kind === 'service') return viewed.name === name;
  return viewed.serviceNames.includes(name);
}

/** True if the given group is currently shown as a group view */
function isGroupViewed(groupId: string, viewed: ViewedTarget): boolean {
  return viewed !== null && viewed.kind === 'group' && viewed.groupId === groupId;
}

/** Get all services needed by currently enabled groups (direct + transitive deps) */
function getServicesNeededByEnabledGroups(enabledGroups: Set<string>): Set<string> {
  const groupIds = [...enabledGroups];
  if (groupIds.length === 0) return new Set();
  return new Set(resolveGroups(groupIds));
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

const GroupHeader = React.memo(function GroupHeader({
  group,
  status,
  selected,
  viewed,
  width,
}: {
  group: ServiceGroup;
  status: GroupStatus;
  selected: boolean;
  viewed: boolean;
  width: number;
}) {
  const statusIcon =
    status === 'on' ? '\u25cf on' : status === 'partial' ? '\u25d4 ...' : '\u25cb off';
  const statusColor = status === 'on' ? 'green' : status === 'partial' ? 'yellow' : 'gray';
  const label = ` ${group.label.toUpperCase()}`;
  const viewedMark = viewed ? ' \u25c4' : '  ';
  const rightPart = ` ${statusIcon}${viewedMark}`;
  const padding = Math.max(1, width - label.length - rightPart.length);

  if (selected) {
    const content = `${label}${' '.repeat(padding)}${rightPart}`;
    const linePad = ' '.repeat(Math.max(0, width - content.length));
    return (
      <Text inverse bold>
        {content}
        {linePad}
      </Text>
    );
  }

  return (
    <Text bold>
      {label}
      {' '.repeat(padding)}
      <Text color={statusColor}>{` ${statusIcon}`}</Text>
      <Text dimColor>{viewedMark}</Text>
    </Text>
  );
});

const ServiceRow = React.memo(function ServiceRow({
  name,
  port,
  status,
  selected,
  viewed,
  width,
}: {
  name: string;
  port: number;
  status: ServiceStatus;
  selected: boolean;
  viewed: boolean;
  width: number;
}) {
  const prefix = selected ? '  \u25b8 ' : '    ';
  const viewedChar = viewed ? ' \u25c0' : '  ';
  const portStr = port > 0 ? `:${port}` : '';
  const statusChar = status === 'up' ? ' \u2713' : status === 'down' ? ' \u2717' : ' \u2026';
  // +1 trailing space, +1 minimum gap between name and port
  const fixedLen = prefix.length + portStr.length + statusChar.length + viewedChar.length + 2;
  const maxName = Math.max(4, width - fixedLen);
  const displayName = name.length > maxName ? name.slice(0, maxName - 1) + '\u2026' : name;
  const namePad = ' '.repeat(Math.max(1, maxName - displayName.length));
  const content = `${prefix}${displayName}${namePad}${portStr}${statusChar}${viewedChar} `;

  if (selected) {
    const linePad = ' '.repeat(Math.max(0, width - content.length));
    return (
      <Text inverse>
        {content}
        {linePad}
      </Text>
    );
  }

  const statusColor = status === 'up' ? 'green' : status === 'down' ? 'red' : 'yellow';
  return (
    <Text>
      {prefix}
      {displayName}
      {namePad}
      <Text dimColor>{portStr}</Text>
      <Text color={statusColor}>{statusChar}</Text>
      {viewed ? <Text dimColor>{viewedChar}</Text> : <Text>{viewedChar}</Text>}{' '}
    </Text>
  );
});

function Dashboard({
  serviceNames: initialServiceNames,
  initialViewed,
  initialEnabledGroupIds,
}: {
  serviceNames: string[];
  initialViewed: string;
  initialEnabledGroupIds: string[];
}) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const rows = stdout?.rows ?? 24;

  // --- State ---
  const [enabledGroups, setEnabledGroups] = useState<Set<string>>(
    () => new Set(initialEnabledGroupIds)
  );
  const [runningServices, setRunningServices] = useState<Set<string>>(
    () => new Set(initialServiceNames)
  );
  const [statuses, setStatuses] = useState<Map<string, ServiceStatus>>(
    () => new Map(initialServiceNames.map(n => [n, 'starting' as const]))
  );
  const [selectedIdx, setSelectedIdx] = useState(0);

  const viewedRef = useRef<ViewedTarget>(
    initialViewed ? { kind: 'service' as const, name: initialViewed } : null
  );
  const scrollRef = useRef(0);
  const startTimeRef = useRef(Date.now());
  const togglingRef = useRef(false);

  // --- Mouse refs (read current values in the stable stdin listener) ---
  const mouseStateRef = useRef({
    sidebarItems: [] as SidebarItem[],
    enabledGroups: new Set<string>(),
    runningServices: new Set<string>(),
    toggleGroupOn: (_groupId: string) => {},
    toggleGroupOff: (_groupId: string) => {},
    showGroup: (_groupId: string) => {},
  });

  // --- Restore sidebar width after terminal resize / tab switch ---
  // The dashboard runs in pane 0, so it receives SIGWINCH whenever tmux
  // proportionally resizes it (e.g. on client resize or terminal tab switch).
  // If the width drifts from SIDEBAR_WIDTH, force it back via resize-pane.
  useEffect(() => {
    const restoreSidebarWidth = () => {
      if (process.stdout.columns !== SIDEBAR_WIDTH) {
        try {
          execSync(`tmux resize-pane -t ${sessionName}:0.0 -x ${SIDEBAR_WIDTH}`, {
            stdio: 'ignore',
          });
        } catch {
          // best-effort
        }
      }
    };
    process.stdout.on('resize', restoreSidebarWidth);
    return () => {
      process.stdout.off('resize', restoreSidebarWidth);
    };
  }, []);

  // --- Derived ---
  const sidebarItems = useMemo(() => buildSidebarItems(enabledGroups), [enabledGroups]);

  // --- Status polling ---
  useEffect(() => {
    const refresh = async () => {
      const servicesToProbe = [...runningServices];
      if (servicesToProbe.length === 0) return;

      const inGrace = Date.now() - startTimeRef.current < STARTING_GRACE_MS;
      const entries = await Promise.all(
        servicesToProbe.map(async (name): Promise<[string, ServiceStatus]> => {
          const svc = getService(name);
          if (svc.port === 0) return [name, 'up'];
          const up = await probePort(svc.port);
          return [name, up ? 'up' : inGrace ? 'starting' : 'down'];
        })
      );
      setStatuses(prev => {
        const changed = entries.some(([name, status]) => prev.get(name) !== status);
        if (!changed) return prev;
        return new Map(entries);
      });
    };
    refresh();
    const timer = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(timer);
  }, [runningServices]);

  // --- Toggle group ON ---
  const toggleGroupOn = useCallback(
    (groupId: string) => {
      if (togglingRef.current) return;
      togglingRef.current = true;

      // Resolve transitive group-level deps (e.g. app-builder → cloud-agent)
      const allGroupIds = resolveGroupTransitiveDeps([groupId]);
      const allNeeded = resolveGroups(allGroupIds);
      const toStart = allNeeded.filter(name => !runningServices.has(name));

      // Start services with staggered delays
      let delay = 0;
      for (const name of toStart) {
        setTimeout(() => {
          try {
            startServiceInTmux(sessionName, name);
          } catch {
            // tmux command failed
          }
        }, delay);
        delay += START_DELAY_MS;
      }

      // Update state after last service started
      setTimeout(() => {
        setRunningServices(prev => {
          const next = new Set(prev);
          for (const name of toStart) next.add(name);
          return next;
        });
        setStatuses(prev => {
          const next = new Map(prev);
          for (const name of toStart) {
            if (!next.has(name)) next.set(name, 'starting');
          }
          return next;
        });
        setEnabledGroups(prev => {
          const next = new Set(prev);
          for (const id of allGroupIds) next.add(id);
          return next;
        });
        // Reset starting grace for newly started services
        startTimeRef.current = Date.now();
        togglingRef.current = false;

        // Show the group in multi-pane view
        const groupServices = getGroupServiceNames(groupId);
        const running = groupServices.filter(n => runningServices.has(n) || toStart.includes(n));
        doShowGroup(groupId, running, viewedRef);
      }, delay + 100);
    },
    [runningServices]
  );

  // --- Toggle group OFF ---
  const toggleGroupOff = useCallback(
    (groupId: string) => {
      if (togglingRef.current) return;
      togglingRef.current = true;

      const directMembers = getGroupServiceNames(groupId);

      // Calculate which services are needed by OTHER enabled groups
      const otherEnabledGroups = new Set(enabledGroups);
      otherEnabledGroups.delete(groupId);
      const neededByOthers = getServicesNeededByEnabledGroups(otherEnabledGroups);

      // Only stop direct members that aren't needed by other groups
      const toStop = directMembers.filter(name => !neededByOthers.has(name));

      // If the current view is affected by the stopped services, switch to another
      const viewed = viewedRef.current;
      const viewedAffected =
        viewed !== null &&
        (viewed.kind === 'group' ? viewed.groupId === groupId : toStop.includes(viewed.name));
      if (viewedAffected) {
        const allRunning = new Set(runningServices);
        for (const name of toStop) allRunning.delete(name);
        const replacement = findViewableService([...allRunning], allRunning);
        if (replacement) {
          doShowService(replacement, viewedRef);
        }
      }

      // Stop services
      for (const name of toStop) {
        try {
          stopServiceInTmux(sessionName, name);
        } catch {
          // tmux command failed
        }
      }

      setRunningServices(prev => {
        const next = new Set(prev);
        for (const name of toStop) next.delete(name);
        return next;
      });
      setStatuses(prev => {
        const next = new Map(prev);
        for (const name of toStop) next.delete(name);
        return next;
      });
      setEnabledGroups(prev => {
        const next = new Set(prev);
        next.delete(groupId);
        return next;
      });
      togglingRef.current = false;
    },
    [enabledGroups, runningServices]
  );

  const showGroup = useCallback(
    (groupId: string) => {
      const running = getGroupServiceNames(groupId).filter(n => runningServices.has(n));
      doShowGroup(groupId, running, viewedRef);
    },
    [runningServices]
  );

  mouseStateRef.current = {
    sidebarItems,
    enabledGroups,
    runningServices,
    toggleGroupOn,
    toggleGroupOff,
    showGroup,
  };

  // --- Keyboard ---
  useInput((input, key) => {
    if (key.upArrow) {
      setSelectedIdx(prev => {
        let next = prev - 1;
        while (next >= 0 && sidebarItems[next]?.kind === 'spacer') next--;
        return Math.max(0, next);
      });
      return;
    }
    if (key.downArrow) {
      setSelectedIdx(prev => {
        let next = prev + 1;
        while (next < sidebarItems.length && sidebarItems[next]?.kind === 'spacer') next++;
        return Math.min(sidebarItems.length - 1, next);
      });
      return;
    }
    if (key.return) {
      const item = sidebarItems[selectedIdx];
      if (!item) return;

      if (item.kind === 'group') {
        if (enabledGroups.has(item.groupId)) {
          // Group is running — show all its services in multi-pane view
          const running = getGroupServiceNames(item.groupId).filter(n => runningServices.has(n));
          doShowGroup(item.groupId, running, viewedRef);
        } else {
          // Group is off — start it (which will also show it)
          if (!alwaysOnGroupIds.has(item.groupId)) {
            toggleGroupOn(item.groupId);
          }
        }
      } else {
        // Service: show single pane
        if (runningServices.has(item.name)) {
          doShowService(item.name, viewedRef);
        }
      }
      return;
    }
    if (input === ' ') {
      const item = sidebarItems[selectedIdx];
      if (!item) return;

      if (item.kind === 'group') {
        // Space stops the group (if it can be stopped)
        if (alwaysOnGroupIds.has(item.groupId)) return;
        if (enabledGroups.has(item.groupId)) {
          toggleGroupOff(item.groupId);
        } else {
          toggleGroupOn(item.groupId);
        }
      } else {
        // Service: show single pane (same as Enter for services)
        if (runningServices.has(item.name)) {
          doShowService(item.name, viewedRef);
        }
      }
      return;
    }
    if (input === 'r') {
      const item = sidebarItems[selectedIdx];
      if (!item || item.kind !== 'service') return;
      if (!runningServices.has(item.name)) return;
      restartServiceInTmux(sessionName, item.name);
      return;
    }
    if (input === 'q') {
      doCleanup();
      exit();
    }
  });

  // --- Mouse tracking ---
  useEffect(() => {
    // Enable SGR extended mouse tracking so tmux forwards clicks to us
    process.stdout.write('\x1b[?1000h\x1b[?1006h');

    const handleStdin = (data: Buffer) => {
      const str = data.toString('utf-8');
      const re = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
      let m;
      while ((m = re.exec(str)) !== null) {
        const button = parseInt(m[1], 10);
        const row = parseInt(m[3], 10); // 1-based terminal row
        const isPress = m[4] === 'M';
        if (!isPress) continue;

        // Scroll wheel: 64 = up, 65 = down
        if (button === 64) {
          const { sidebarItems: items } = mouseStateRef.current;
          setSelectedIdx(prev => {
            let next = prev - 1;
            while (next >= 0 && items[next]?.kind === 'spacer') next--;
            return Math.max(0, next);
          });
          continue;
        }
        if (button === 65) {
          const { sidebarItems: items } = mouseStateRef.current;
          setSelectedIdx(prev => {
            let next = prev + 1;
            while (next < items.length && items[next]?.kind === 'spacer') next++;
            return Math.min(items.length - 1, next);
          });
          continue;
        }

        // Left click only
        if (button !== 0) continue;

        const {
          sidebarItems: items,
          enabledGroups: groups,
          runningServices: running,
          toggleGroupOn: onGroupOn,
          showGroup: onShowGroup,
        } = mouseStateRef.current;

        // 2 header rows, then visible items starting from scrollRef offset
        const itemRow = row - 1 - 2 + scrollRef.current;
        if (itemRow < 0 || itemRow >= items.length) continue;

        setSelectedIdx(itemRow);

        const item = items[itemRow];
        if (!item || item.kind === 'spacer') continue;

        if (item.kind === 'group') {
          if (groups.has(item.groupId)) {
            // Click on running group header = show group view
            onShowGroup(item.groupId);
          } else {
            // Click on stopped group header = start it
            if (!alwaysOnGroupIds.has(item.groupId)) {
              onGroupOn(item.groupId);
            }
          }
        } else {
          if (running.has(item.name)) {
            doShowService(item.name, viewedRef);
          }
        }
      }
    };

    process.stdin.on('data', handleStdin);

    return () => {
      process.stdout.write('\x1b[?1000l\x1b[?1006l');
      process.stdin.off('data', handleStdin);
    };
    // Stable listener — reads current values from mouseStateRef
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Scrolling ---
  const headerCount = 2;
  const footerCount = 1;
  const visibleCount = Math.max(1, rows - headerCount - footerCount);
  if (selectedIdx >= scrollRef.current + visibleCount) {
    scrollRef.current = selectedIdx - visibleCount + 1;
  }
  if (selectedIdx < scrollRef.current) {
    scrollRef.current = selectedIdx;
  }
  const visibleItems = sidebarItems.slice(scrollRef.current, scrollRef.current + visibleCount);

  return (
    <Box flexDirection="column" height={rows} width={SIDEBAR_WIDTH}>
      <Text bold> SERVICES</Text>
      <Text> </Text>

      <Box flexDirection="column" flexGrow={1}>
        {visibleItems.map((item, i) => {
          const globalIdx = scrollRef.current + i;
          const isSelected = globalIdx === selectedIdx;

          if (item.kind === 'spacer') {
            return <Text key={`spacer-${globalIdx}`}> </Text>;
          }

          if (item.kind === 'group') {
            const group = groupsById.get(item.groupId);
            if (!group) return null;
            return (
              <GroupHeader
                key={`group-${item.groupId}`}
                group={group}
                status={computeGroupStatus(item.groupId, statuses)}
                selected={isSelected}
                viewed={isGroupViewed(item.groupId, viewedRef.current)}
                width={SIDEBAR_WIDTH}
              />
            );
          }

          const svc = getService(item.name);
          return (
            <ServiceRow
              key={`svc-${item.name}`}
              name={item.name}
              port={svc.port}
              status={statuses.get(item.name) ?? 'down'}
              selected={isSelected}
              viewed={isServiceViewed(item.name, viewedRef.current)}
              width={SIDEBAR_WIDTH}
            />
          );
        })}
      </Box>

      <Text dimColor>
        {' '}
        {'\u2191\u2193'} navigate {'\u23ce'} view/start space stop r restart q quit
      </Text>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const serviceNames: string[] = JSON.parse(process.argv[2] ?? '[]');
const initialViewed = process.argv[3] ?? '';
const initialEnabledGroupIds: string[] = JSON.parse(process.argv[4] ?? '[]');

if (serviceNames.length === 0) {
  console.error(
    "Usage: dashboard.tsx '<json-service-names>' [initial-service] '<json-enabled-groups>'"
  );
  process.exit(1);
}

// Batch stdout writes so ink's per-line updates arrive as a single
// atomic write, preventing tmux from rendering intermediate frames.
{
  const origWrite = process.stdout.write.bind(process.stdout);
  let batch: Buffer[] = [];
  let scheduled = false;
  process.stdout.write = function stdoutBatchedWrite(
    chunk: Uint8Array | string,
    encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
    cb?: (err?: Error | null) => void
  ): boolean {
    batch.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk));
    if (!scheduled) {
      scheduled = true;
      queueMicrotask(() => {
        const combined = Buffer.concat(batch);
        batch = [];
        scheduled = false;
        origWrite(combined);
      });
    }
    const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb;
    if (callback) callback();
    return true;
  };
}

// Clear screen so ink starts with a clean canvas
process.stdout.write('\x1b[2J\x1b[H');

const { waitUntilExit } = render(
  <Dashboard
    serviceNames={serviceNames}
    initialViewed={initialViewed}
    initialEnabledGroupIds={initialEnabledGroupIds}
  />
);

waitUntilExit().then(() => {
  process.exit(0);
});
