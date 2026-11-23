import { buildOpaqueScopeKey } from '@kilocode/app-shared/glanceable-agents-snapshot';
import {
  buildHomeWidgetPresentation,
  buildHomeWidgetPresentationTimeline,
  homeWidgetRefreshAt,
} from '@kilocode/app-shared/home-widget';

import { currentAuthEpoch } from '@/lib/auth/auth-epoch';
import { API_BASE_URL } from '@/lib/config';
import { trpcClient } from '@/lib/trpc';

import { holdGlanceableFixture, releaseGlanceableFixtureHold } from './fixture-hold';
import { getHomeWidgetCopy } from './home-widget-copy';
import { getLastHomeWidgetData } from './home-widget-data';
import { HomeWidgetRefresh } from './home-widget-refresh';
import { getActiveUserId, getSelectedOrganizationId } from './scope';

/**
 * Dev-only widget scope fixture. `kiloapp:///dev/home-widget-scope-fixture/<step>`
 * drives the native `configure` with chosen scopes, so the path that
 * unregisters a replaced scope's widget push token can be exercised on a
 * simulator, where WidgetKit never delivers a real push token:
 *
 * - `store` enables fixture mode, writes the stand-in push token, then
 *   configures a synthetic scope (`fixture:outgoing`, epoch 0) with a real
 *   widget credential.
 * - `register` posts that stand-in token to the widget push-token endpoint with
 *   a real credential: the row a later retirement must delete.
 * - `same` configures the same synthetic scope again, so the native side keeps
 *   the stored scope and retires nothing.
 * - `changed` configures the app's signed-in scope, so the native side replaces
 *   the synthetic one and unregisters the stand-in token with the credential
 *   the synthetic scope stored.
 * - `off` disables fixture mode, clears the stand-in token, then releases the
 *   hold.
 *
 * Fixture mode holds every token upload back and the JS fixture hold stops the
 * live `syncHomeWidgetRefresh` from configuring the app's own scope between the
 * steps, so only the configure this fixture issues can post anything; `off`
 * releases the hold and hands the surfaces back. Each step
 * appends one line to the Metro log, because the run is read from device logs.
 * The only entry point is `+native-intent.tsx`, behind `__DEV__`; a release
 * build never calls this module.
 */

const FIXTURE_PATH =
  /(?:^|\/)dev\/home-widget-scope-fixture\/(store|register|same|changed|off)\/?(?:[?#].*)?$/;

/**
 * The stand-in widget push token: 64 lowercase hex characters, the shape the
 * server mints. Nothing is ever pushed to it, so the registration it creates
 * reaches no device.
 */
const STAND_IN_TOKEN = '3f7a1c02d94b6e510a8c2f37b5e1d84c76f03a9bc24d5e189b6a7f204e1c8d3a';

/** The synthetic scope the fixture stores and the `changed` step replaces. */
const SYNTHETIC_SCOPE = { scopeKey: 'fixture:outgoing', accountEpoch: 0 };

type FixtureStep = 'store' | 'register' | 'same' | 'changed' | 'off';

function log(message: string): void {
  // eslint-disable-next-line no-console -- dev-only fixture feedback in the Metro log
  console.log(`home-widget-scope-fixture ${message}`);
}

/** A real widget credential for the selected scope; fixture steps never fake one. */
async function mintCredential(organizationId: string | null): Promise<string> {
  const issued = await trpcClient.activeSessions.widgetCredential.query({ organizationId });
  return issued.token;
}

/**
 * The payload `syncHomeWidgetRefresh` builds, as JSON text. The presentation
 * fields come from the last confirmed record when there is one; the native side
 * ignores them when there is not.
 */
function configurePayload(input: {
  scopeKey: string;
  accountEpoch: number;
  organizationId: string | null;
  token: string;
}): string {
  const copy = getHomeWidgetCopy();
  const payload = {
    endpoint: `${API_BASE_URL}/api/mobile/widgets`,
    token: input.token,
    organizationId: input.organizationId,
    scopeKey: input.scopeKey,
    accountEpoch: input.accountEpoch,
    operationEpoch: (HomeWidgetRefresh?.getOperationEpoch() ?? 0) + 1,
    copy,
    locale: copy.locale,
  };
  const data = getLastHomeWidgetData();
  if (data === null) {
    return JSON.stringify(payload);
  }
  const now = Date.now();
  return JSON.stringify({
    ...payload,
    data,
    home: buildHomeWidgetPresentation(data, now),
    refreshAt: homeWidgetRefreshAt(data, now),
    presentationTimeline: buildHomeWidgetPresentationTimeline(data, now),
  });
}

/** Configure the synthetic scope with a fresh credential; the token is the caller's. */
async function configureSyntheticScope(): Promise<void> {
  const organizationId = await getSelectedOrganizationId();
  const token = await mintCredential(organizationId);
  await HomeWidgetRefresh?.configure(
    configurePayload({ ...SYNTHETIC_SCOPE, organizationId, token })
  );
}

/** Configure the signed-in scope, so native retires the synthetic one. */
async function replaceWithRealScope(): Promise<string> {
  const [userId, organizationId] = await Promise.all([
    getActiveUserId(),
    getSelectedOrganizationId(),
  ]);
  if (userId === null) {
    return 'skipped (no signed-in user)';
  }
  const token = await mintCredential(organizationId);
  await HomeWidgetRefresh?.configure(
    configurePayload({
      scopeKey: buildOpaqueScopeKey({ userId, organizationId }),
      accountEpoch: currentAuthEpoch(),
      organizationId,
      token,
    })
  );
  return 'replaced the synthetic scope';
}

/** Register the stand-in token for the synthetic scope, so retirement has a row to delete. */
async function registerStandInToken(): Promise<string> {
  const organizationId = await getSelectedOrganizationId();
  const token = await mintCredential(organizationId);
  const response = await fetch(`${API_BASE_URL}/api/mobile/widgets/push-token`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: STAND_IN_TOKEN, enabled: true }),
  });
  return `posted the stand-in token (HTTP ${response.status})`;
}

async function runStep(step: FixtureStep): Promise<string> {
  if (step === 'off') {
    await HomeWidgetRefresh?.setFixtureMode(false);
    await HomeWidgetRefresh?.setFixturePushToken?.(null);
    // The release in `off` hands the surfaces back to the live publisher.
    releaseGlanceableFixtureHold();
    return 'fixture mode off, token cleared, hold released';
  }
  if (HomeWidgetRefresh === null) {
    return 'skipped (native module absent)';
  }
  // The JS hold stops the live sync from configuring between the steps.
  holdGlanceableFixture();
  // Before anything posts: fixture mode holds every other upload back.
  await HomeWidgetRefresh.setFixtureMode(true);
  if (step === 'store') {
    await HomeWidgetRefresh.setFixturePushToken?.(STAND_IN_TOKEN);
    await configureSyntheticScope();
    return 'stored the synthetic scope';
  }
  if (step === 'register') {
    return registerStandInToken();
  }
  if (step === 'same') {
    // The scope is already stored: writing the token again would prove nothing.
    await configureSyntheticScope();
    return 'kept the synthetic scope';
  }
  return replaceWithRealScope();
}

/** One log line per step, whether it finished or failed; no rejection escapes. */
async function startStep(step: FixtureStep): Promise<void> {
  try {
    log(`${step} ${await runStep(step)}`);
  } catch (error) {
    log(`${step} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Handle a widget scope fixture link. True when the path is one (handled, even
 * when the step fails), so the caller returns falsy and nothing navigates.
 */
export function handleHomeWidgetScopeFixturePath(path: string): boolean {
  const step = FIXTURE_PATH.exec(path)?.[1];
  if (
    step !== 'store' &&
    step !== 'register' &&
    step !== 'same' &&
    step !== 'changed' &&
    step !== 'off'
  ) {
    return false;
  }
  void startStep(step);
  return true;
}
