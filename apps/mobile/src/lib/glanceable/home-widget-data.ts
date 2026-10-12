import {
  GLANCEABLE_SNAPSHOT_EXPIRY_MS,
  type GlanceableAgentsSnapshot,
} from '@kilocode/app-shared/glanceable-agents-snapshot';
import {
  EMPTY_HOME_WIDGET_DETAILS,
  type HomeWidgetData,
  homeWidgetDataSchema,
  type HomeWidgetDetails,
} from '@kilocode/app-shared/home-widget';

import { reportSecureStoreFailure } from '@/lib/telemetry/secure-store-events';

const HOME_WIDGET_DATA_KEY = 'home-widget-data';

type HomeWidgetStore = {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
};

let storeForTests: HomeWidgetStore | null = null;
let lastData: HomeWidgetData | null = null;
let details: HomeWidgetDetails = EMPTY_HOME_WIDGET_DETAILS;
let confirmedAt: number | null = null;
let epoch = 0;
let writes: Promise<void> | null = null;
const listeners = new Set<() => void>();

function store(): HomeWidgetStore {
  if (storeForTests !== null) {
    return storeForTests;
  }
  // eslint-disable-next-line typescript-eslint/no-require-imports, typescript-eslint/no-var-requires, unicorn/prefer-module -- headless-safe lazy native load
  return require('expo-secure-store') as HomeWidgetStore;
}

function changed(): void {
  for (const listener of listeners) {
    listener();
  }
}

/** Each write waits for the previous one so the mirror never lands out of order. */
async function writeAfter(previous: Promise<void> | null, raw: string): Promise<void> {
  await previous;
  try {
    await store().setItemAsync(HOME_WIDGET_DATA_KEY, raw);
  } catch (error) {
    reportSecureStoreFailure('write', error);
  }
}

function mirror(data: HomeWidgetData | null): void {
  writes = writeAfter(writes, JSON.stringify(data));
}

/** Home-only private details never enter the generic glanceable snapshot. */
export function setHomeWidgetDetails(
  next: HomeWidgetDetails,
  checkedAt: number | null = null
): void {
  details = next;
  confirmedAt = checkedAt;
}

export function getLastHomeWidgetData(): HomeWidgetData | null {
  return lastData;
}

export function subscribeHomeWidgetData(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function clearHomeWidgetData(): void {
  epoch += 1;
  lastData = null;
  details = EMPTY_HOME_WIDGET_DETAILS;
  confirmedAt = null;
  mirror(null);
  changed();
}

/** Accept only a confirmed fetch. Render time and failed fetches cannot renew the timestamp. */
export function rememberHomeWidgetData(data: HomeWidgetData): boolean {
  const snapshot = data.snapshot;
  if (snapshot.status === 'signed_out' || snapshot.status === 'privacy') {
    epoch += 1;
    details = EMPTY_HOME_WIDGET_DETAILS;
    lastData = { snapshot, details };
    mirror(lastData);
    changed();
    return true;
  }
  if (snapshot.status !== 'happy' && snapshot.status !== 'empty') {
    return false;
  }
  if (
    lastData?.snapshot.scopeKey === snapshot.scopeKey &&
    Date.parse(snapshot.updatedAt) < Date.parse(lastData.snapshot.updatedAt)
  ) {
    return false;
  }
  epoch += 1;
  lastData = data;
  details = data.details;
  mirror(data);
  changed();
  return true;
}

/** Record before native sinks draw. Activity expiry must not erase the Home record. */
export function rememberHomeWidgetSnapshot(snapshot: GlanceableAgentsSnapshot): void {
  const homeSnapshot =
    confirmedAt !== null && (snapshot.status === 'happy' || snapshot.status === 'empty')
      ? {
          ...snapshot,
          updatedAt: new Date(confirmedAt).toISOString(),
          expiresAt: new Date(confirmedAt + GLANCEABLE_SNAPSHOT_EXPIRY_MS).toISOString(),
        }
      : snapshot;
  rememberHomeWidgetData({ snapshot: homeSnapshot, details });
}

export function getHomeWidgetDataForSnapshot(snapshot: GlanceableAgentsSnapshot): HomeWidgetData {
  if (snapshot.status === 'signed_out' || snapshot.status === 'privacy') {
    return { snapshot, details: EMPTY_HOME_WIDGET_DETAILS };
  }
  if (lastData?.snapshot.status === 'signed_out' || lastData?.snapshot.status === 'privacy') {
    return { snapshot: lastData.snapshot, details: EMPTY_HOME_WIDGET_DETAILS };
  }
  const retained = lastData?.snapshot.scopeKey === snapshot.scopeKey ? lastData : null;
  if (retained !== null) {
    if (snapshot.status === 'stale' || snapshot.status === 'expired') {
      return {
        ...retained,
        snapshot:
          retained.snapshot.status === 'empty'
            ? retained.snapshot
            : { ...retained.snapshot, status: 'stale' },
      };
    }
    if (
      snapshot.status === 'waiting' ||
      Date.parse(snapshot.updatedAt) <= Date.parse(retained.snapshot.updatedAt)
    ) {
      return retained;
    }
  }
  return {
    snapshot,
    details:
      snapshot.status === 'happy' || snapshot.status === 'empty'
        ? details
        : EMPTY_HOME_WIDGET_DETAILS,
  };
}

/** Corrupt stored JSON is treated like a missing record. */
function parseStoredHomeWidgetData(raw: string): HomeWidgetData | null {
  try {
    const parsed = homeWidgetDataSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** A scope fence and live-write epoch prevent restores from resurrecting private data. */
export async function restoreHomeWidgetData(scopeKey: string | null): Promise<void> {
  if (scopeKey === null || scopeKey.startsWith('terminal:') || lastData !== null) {
    return;
  }
  const startedAtEpoch = epoch;
  try {
    const raw = await store().getItemAsync(HOME_WIDGET_DATA_KEY);
    if (raw === null || epoch !== startedAtEpoch) {
      return;
    }
    const stored = parseStoredHomeWidgetData(raw);
    if (
      stored === null ||
      stored.snapshot.scopeKey !== scopeKey ||
      (stored.snapshot.status !== 'happy' &&
        stored.snapshot.status !== 'empty' &&
        stored.snapshot.status !== 'privacy')
    ) {
      return;
    }
    lastData = stored;
    details = stored.details;
    changed();
  } catch (error) {
    reportSecureStoreFailure('read', error);
  }
}

export function hasSameHomeWidgetDetails(a: HomeWidgetDetails, b: HomeWidgetDetails): boolean {
  return (
    a.primaryTitle === b.primaryTitle &&
    a.waitingAgents.length === b.waitingAgents.length &&
    a.waitingAgents.every((row, index) => {
      const other = b.waitingAgents[index];
      return row.title === other?.title && row.kind === other.kind;
    }) &&
    a.scheduledAgents.length === b.scheduledAgents.length &&
    a.scheduledAgents.every((row, index) => {
      const other = b.scheduledAgents[index];
      return row.title === other?.title && row.scheduledAt === other.scheduledAt;
    })
  );
}

export function _setHomeWidgetStoreForTests(next: HomeWidgetStore | null): void {
  storeForTests = next;
}

export function _resetHomeWidgetDataForTests(): void {
  epoch += 1;
  lastData = null;
  details = EMPTY_HOME_WIDGET_DETAILS;
  confirmedAt = null;
  storeForTests = null;
  listeners.clear();
}
