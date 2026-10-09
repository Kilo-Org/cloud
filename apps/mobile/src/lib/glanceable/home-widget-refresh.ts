import * as Sentry from '@sentry/react-native';
import {
  buildGlanceableSnapshot,
  buildOpaqueScopeKey,
} from '@kilocode/app-shared/glanceable-agents-snapshot';
import {
  buildHomeWidgetPresentation,
  buildHomeWidgetPresentationTimeline,
  EMPTY_HOME_WIDGET_DETAILS,
  type HomeWidgetData,
  homeWidgetDataSchema,
  type HomeWidgetPresentation,
  homeWidgetRefreshAt,
  homeWidgetResponseSchema,
  type HomeWidgetTimelineEntry,
} from '@kilocode/app-shared/home-widget';
import { requireOptionalNativeModule } from 'expo';
import { z } from 'zod';

import { end as endLiveUpdate, setWidgetSnapshot } from '@/glanceable-android/live-update';
import { currentAuthEpoch } from '@/lib/auth/auth-epoch';
import { isSignOutTeardownActive } from '@/lib/auth/token-owner';
import { API_BASE_URL } from '@/lib/config';
import { trpcClient } from '@/lib/trpc';

import { getTerminalBlankEpoch, isGlanceableOrgLost } from './cleanup';
import { isGlanceableFixtureHeld } from './fixture-hold';
import { getHomeWidgetCopy } from './home-widget-copy';
import {
  getLastHomeWidgetData,
  rememberHomeWidgetData,
  subscribeHomeWidgetData,
} from './home-widget-data';
import { getActiveUserId, getSelectedOrganizationId } from './scope';

type NativeRefreshContext = {
  scopeKey: string;
  accountEpoch: number;
  generation: string;
};

type HomeWidgetRefreshModule = {
  configure(config: {
    endpoint: string;
    token: string;
    organizationId: string | null;
    scopeKey: string;
    accountEpoch: number;
    operationEpoch: number;
    copy: Record<string, string>;
    locale: string;
    data: HomeWidgetData;
    home: HomeWidgetPresentation;
    refreshAt: number;
    presentationTimeline: HomeWidgetTimelineEntry[];
  }): Promise<void>;
  clear(operationEpoch: number): Promise<void>;
  getOperationEpoch(): number;
  setFixtureMode(enabled: boolean): Promise<void>;
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- raw native payload, parsed by homeWidgetDataSchema in restoreNativeHomeWidgetData
  getData(): Promise<unknown>;
  getWidgetPushToken(): Promise<string | null>;
  widgetsChanged(): Promise<void>;
  isCurrent(scopeKey: string, accountEpoch: number, generation: string): Promise<boolean>;
};

export const HomeWidgetRefresh =
  requireOptionalNativeModule<HomeWidgetRefreshModule>('HomeWidgetRefresh');

const terminalResponseSchema = z.object({ terminal: z.literal('privacy') });
let configurationEpoch = 0;
let clearPromise: Promise<void> | null = null;
let credential: {
  scopeKey: string;
  accountEpoch: number;
  token: string;
  expiresAt: number;
} | null = null;

function report(error: unknown, operation: string): void {
  Sentry.captureException(error, {
    tags: { 'error.subsystem': 'home_widget', 'error.operation': operation },
  });
}

async function clearNativeRefresh(): Promise<void> {
  try {
    configurationEpoch =
      Math.max(configurationEpoch, HomeWidgetRefresh?.getOperationEpoch() ?? 0) + 1;
    await HomeWidgetRefresh?.clear(configurationEpoch);
  } catch (error) {
    report(error, 'clear_native_refresh');
  } finally {
    clearPromise = null;
  }
}

/** Clears protected native state even when no publisher remains mounted. */
export async function clearHomeWidgetRefresh(): Promise<void> {
  configurationEpoch += 1;
  credential = null;
  clearPromise ??= clearNativeRefresh();
  await clearPromise;
}

/** The foreground app renews a dedicated read-only credential, never shares its refresh token. */
export async function syncHomeWidgetRefresh(context: {
  userId: string;
  organizationId: string | null;
}): Promise<void> {
  if (HomeWidgetRefresh === null || isGlanceableFixtureHeld()) {
    return;
  }
  if (clearPromise !== null) {
    await clearPromise;
  }
  const data = getLastHomeWidgetData();
  if (
    data === null ||
    data.snapshot.status === 'signed_out' ||
    data.snapshot.status === 'privacy' ||
    isSignOutTeardownActive() ||
    isGlanceableOrgLost()
  ) {
    await clearHomeWidgetRefresh();
    return;
  }
  const scopeKey = buildOpaqueScopeKey(context);
  if (data.snapshot.scopeKey !== scopeKey) {
    return;
  }
  configurationEpoch += 1;
  let epoch = configurationEpoch;
  const authEpoch = currentAuthEpoch();
  const blankEpoch = getTerminalBlankEpoch();
  const superseded = () =>
    configurationEpoch !== epoch ||
    currentAuthEpoch() !== authEpoch ||
    getTerminalBlankEpoch() !== blankEpoch ||
    isSignOutTeardownActive() ||
    isGlanceableOrgLost() ||
    isGlanceableFixtureHeld() ||
    getLastHomeWidgetData()?.snapshot.scopeKey !== scopeKey;
  try {
    epoch = Math.max(epoch, HomeWidgetRefresh.getOperationEpoch() + 1);
    configurationEpoch = epoch;
    if (
      credential?.scopeKey !== scopeKey ||
      credential.accountEpoch !== authEpoch ||
      credential.expiresAt <= Date.now() + 86_400_000
    ) {
      const issued = await trpcClient.activeSessions.widgetCredential.query({
        organizationId: context.organizationId,
      });
      if (superseded()) {
        return;
      }
      credential = { ...issued, scopeKey, accountEpoch: authEpoch };
    }
    const configuredCredential = credential;
    if (superseded()) {
      return;
    }
    const now = Date.now();
    const copy = getHomeWidgetCopy();
    await HomeWidgetRefresh.configure({
      endpoint: `${API_BASE_URL}/api/mobile/widgets`,
      token: configuredCredential.token,
      organizationId: context.organizationId,
      scopeKey,
      accountEpoch: authEpoch,
      operationEpoch: epoch,
      copy,
      locale: copy.locale,
      data,
      home: buildHomeWidgetPresentation(data, now),
      refreshAt: homeWidgetRefreshAt(data, now),
      presentationTimeline: buildHomeWidgetPresentationTimeline(data, now),
    });
  } catch (error) {
    if (!superseded()) {
      report(error, 'configure_native_refresh');
    }
  }
}

/** Native callbacks cannot cross an account change, terminal blank, or newer native generation. */
export async function applyHomeWidgetResponse(
  response: unknown,
  context: NativeRefreshContext
): Promise<boolean> {
  if (HomeWidgetRefresh === null || isGlanceableFixtureHeld() || isSignOutTeardownActive()) {
    return false;
  }
  const authEpoch = currentAuthEpoch();
  const blankEpoch = getTerminalBlankEpoch();
  const [userId, organizationId] = await Promise.all([
    getActiveUserId(),
    getSelectedOrganizationId(),
  ]);
  if (
    userId === null ||
    buildOpaqueScopeKey({ userId, organizationId }) !== context.scopeKey ||
    currentAuthEpoch() !== authEpoch ||
    getTerminalBlankEpoch() !== blankEpoch ||
    isGlanceableOrgLost() ||
    isSignOutTeardownActive() ||
    isGlanceableFixtureHeld() ||
    !(await HomeWidgetRefresh.isCurrent(context.scopeKey, context.accountEpoch, context.generation))
  ) {
    return false;
  }
  if (currentAuthEpoch() !== authEpoch || getTerminalBlankEpoch() !== blankEpoch) {
    return false;
  }
  if (terminalResponseSchema.safeParse(response).success) {
    const snapshot = buildGlanceableSnapshot({
      sessions: [],
      userId,
      organizationId,
      now: Date.now(),
      accountEpoch: authEpoch,
      status: 'privacy',
    });
    rememberHomeWidgetData({ snapshot, details: EMPTY_HOME_WIDGET_DETAILS });
    setWidgetSnapshot(snapshot);
    endLiveUpdate();
    return true;
  }
  const parsed = homeWidgetResponseSchema.safeParse(response);
  if (!parsed.success || parsed.data.snapshot.scopeKey !== context.scopeKey) {
    return false;
  }
  return rememberHomeWidgetData({ snapshot: parsed.data.snapshot, details: parsed.data.details });
}

/** Adopt native fetches after a JS restart without comparing process-local auth epochs. */
export async function restoreNativeHomeWidgetData(): Promise<void> {
  if (HomeWidgetRefresh === null || isSignOutTeardownActive() || isGlanceableFixtureHeld()) {
    return;
  }
  const authEpoch = currentAuthEpoch();
  const blankEpoch = getTerminalBlankEpoch();
  try {
    const [raw, userId, organizationId] = await Promise.all([
      HomeWidgetRefresh.getData(),
      getActiveUserId(),
      getSelectedOrganizationId(),
    ]);
    const parsed = homeWidgetDataSchema.safeParse(raw);
    if (
      !parsed.success ||
      userId === null ||
      parsed.data.snapshot.scopeKey !== buildOpaqueScopeKey({ userId, organizationId }) ||
      currentAuthEpoch() !== authEpoch ||
      getTerminalBlankEpoch() !== blankEpoch ||
      isSignOutTeardownActive() ||
      isGlanceableOrgLost()
    ) {
      return;
    }
    rememberHomeWidgetData(parsed.data);
  } catch (error) {
    report(error, 'restore_native_data');
  }
}

subscribeHomeWidgetData(() => {
  if (getLastHomeWidgetData() === null) {
    void clearHomeWidgetRefresh();
  }
});
