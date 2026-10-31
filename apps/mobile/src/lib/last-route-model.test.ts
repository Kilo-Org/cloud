// eslint-disable-next-line import/no-nodejs-modules -- vitest-only check, runs in node, never bundled into the app
import { readFileSync } from 'node:fs';
// eslint-disable-next-line import/no-nodejs-modules -- vitest-only check, runs in node, never bundled into the app
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { PICKER_ROUTE_PATHS } from './picker-routes';
import {
  isConcreteLastRouteHref,
  isRecordableLastRoute,
  isUnrestorableLastRouteHref,
  lastRouteHrefFrom,
} from './last-route-recordable';
import { shouldRepairRestoredRoute } from './last-route-repair';

describe('isConcreteLastRouteHref', () => {
  it('accepts a resolved route', () => {
    expect(isConcreteLastRouteHref('/profiles/p1/variables')).toBe(true);
    expect(isConcreteLastRouteHref('/agent-chat/ses_1?at=msg_1')).toBe(true);
  });

  it('rejects a route pattern and an empty href', () => {
    expect(isConcreteLastRouteHref('/profiles/[profileId]/variables')).toBe(false);
    expect(isConcreteLastRouteHref('')).toBe(false);
  });
});

describe('isUnrestorableLastRouteHref', () => {
  it('rejects a persisted picker or transient sheet, groups and query included', () => {
    expect(isUnrestorableLastRouteHref('/(app)/agent-chat/repo-picker')).toBe(true);
    expect(isUnrestorableLastRouteHref('/(app)/agent-chat/model-picker?routeKey=unscoped')).toBe(
      true
    );
    expect(isUnrestorableLastRouteHref('/(app)/voice-language-picker')).toBe(true);
    expect(isUnrestorableLastRouteHref('/(app)/todos/list-settings?listId=l1')).toBe(true);
  });

  it('accepts the screens a record may reopen', () => {
    expect(isUnrestorableLastRouteHref('/(app)/agent-chat/new?organizationId=org_1')).toBe(false);
    expect(isUnrestorableLastRouteHref('/(app)/agent-chat/ses_1')).toBe(false);
    expect(isUnrestorableLastRouteHref('/(app)/(tabs)/(0_home)')).toBe(false);
  });
});

describe('lastRouteHrefFrom', () => {
  it('keeps the tab-group identity from concrete segments', () => {
    // `usePathname()` reports `/` for a tab root and the global href repeats it;
    // only the segment list names the tab the person left.
    expect(
      lastRouteHrefFrom('/?profileId=%5BprofileId%5D&initial=false', '/', [
        '(app)',
        '(tabs)',
        '(3_profile)',
      ])
    ).toBe('/(app)/(tabs)/(3_profile)');
  });

  it('uses the resolved global href when a segment is a route pattern', () => {
    expect(
      lastRouteHrefFrom('/profiles/p1/variables?initial=false', '/profiles/p1/variables', [
        '(app)',
        '(tabs)',
        '(3_profile)',
        'profiles',
        '[profileId]',
        'variables',
      ])
    ).toBe('/profiles/p1/variables');
  });

  it('keeps the query the screen was opened with', () => {
    expect(
      lastRouteHrefFrom('/profiles/p1/variables?organizationId=o1', '/profiles/p1/variables', [
        '(app)',
        '(tabs)',
        '(3_profile)',
        'profiles',
        '[profileId]',
        'variables',
      ])
    ).toBe('/profiles/p1/variables?organizationId=o1');
  });

  it('drops the launch flag and query values that never resolved', () => {
    expect(
      lastRouteHrefFrom('/agent-chat/ses_1?initial=false', '/agent-chat/ses_1', [
        '(app)',
        'agent-chat',
        'ses_1',
      ])
    ).toBe('/(app)/agent-chat/ses_1');
    expect(
      lastRouteHrefFrom(
        '/profiles/p1/variables?initial=false&organizationId=o1',
        '/profiles/p1/variables',
        ['(app)', '(tabs)', '(3_profile)', 'profiles', '[profileId]', 'variables']
      )
    ).toBe('/profiles/p1/variables?organizationId=o1');
  });

  it('falls back to the pathname when nothing else resolved', () => {
    expect(lastRouteHrefFrom('', '/agent-chat/ses_1', [])).toBe('/agent-chat/ses_1');
  });

  it('returns null when no source names a concrete route', () => {
    expect(lastRouteHrefFrom('', '', [])).toBeNull();
    expect(
      lastRouteHrefFrom('/profiles/[profileId]/variables', '/profiles/[profileId]/variables', [
        '(app)',
        '(tabs)',
        '(3_profile)',
        'profiles',
        '[profileId]',
        'variables',
      ])
    ).toBeNull();
  });
});

describe('isRecordableLastRoute', () => {
  it('records in-app surfaces', () => {
    expect(
      isRecordableLastRoute('/(app)/(tabs)/(3_profile)/profiles/p1/variables', [
        '(app)',
        '(tabs)',
        '(3_profile)',
        'profiles',
        'p1',
        'variables',
      ])
    ).toBe(true);
    expect(isRecordableLastRoute('/(app)/agent-chat/ses_1', ['(app)', 'agent-chat', 'ses_1'])).toBe(
      true
    );
  });

  it('keeps the record on the screen under a bridge picker', () => {
    // A picker sheet's options live in a module map that a fresh JS context
    // starts empty, so reopening one on its own paints the expired shell over
    // the start route. The record must stay on the form that opened it.
    for (const pathname of PICKER_ROUTE_PATHS) {
      expect(isRecordableLastRoute(pathname, ['(app)', ...pathname.slice(1).split('/')])).toBe(
        false
      );
    }
    expect(isRecordableLastRoute('/(app)/agent-chat/new', ['(app)', 'agent-chat', 'new'])).toBe(
      true
    );
  });

  it('records nothing outside the app group', () => {
    expect(isRecordableLastRoute('/(auth)/login', ['(auth)', 'login'])).toBe(false);
    expect(isRecordableLastRoute('/force-update', ['force-update'])).toBe(false);
    expect(isRecordableLastRoute('/', [])).toBe(false);
  });

  it('records nothing on gate and flow-control routes', () => {
    for (const pathname of [
      '/consent',
      '/consent-details',
      '/language-picker',
      '/force-update',
      '/share-gate',
      '/onboarding',
      '/tour',
      '/kilo-pass',
    ]) {
      expect(isRecordableLastRoute(pathname, ['(app)', pathname.slice(1)])).toBe(false);
    }
  });

  it('records nothing on a transient sheet, so its opener stays the target', () => {
    for (const pathname of [
      '/transcription-model-picker',
      '/voice-language-picker',
      '/todos/list-settings',
      '/chat/instance-picker',
    ]) {
      expect(isRecordableLastRoute(pathname, ['(app)', ...pathname.slice(1).split('/')])).toBe(
        false
      );
    }
  });

  it('covers every sheet the app stack registers', () => {
    // The app stack presents a sheet over the screen that opened it, so no
    // sheet is a relaunch target: the record belongs to the opener. Reading the
    // layout keeps a new registration from silently becoming recordable.
    const app = fileURLToPath(new URL('../app/(app)/_layout.tsx', import.meta.url));
    const tags = [...readFileSync(app, 'utf8').matchAll(/<Stack\.Screen\b[\s\S]*?\/>/g)].map(
      match => match[0]
    );
    const sheets = tags
      .filter(tag => tag.includes('heetOptions'))
      .map(tag => /name="([^"]+)"/.exec(tag)?.[1] ?? '');
    expect(sheets.length).toBeGreaterThan(0);
    for (const name of sheets) {
      expect(isRecordableLastRoute(`/${name}`, ['(app)', ...name.split('/')]), name).toBe(false);
    }
  });
});

describe('shouldRepairRestoredRoute', () => {
  it('repairs when the record differs from the restored route', () => {
    expect(
      shouldRepairRestoredRoute({
        recordedHref: '/(app)/(tabs)/(3_profile)/profiles/p1/variables',
        restoredRoute: '/agent-chat/ses_gone',
      })
    ).toBe(true);
  });

  it('does not repair when the OS restore already reopened the recorded screen', () => {
    expect(
      shouldRepairRestoredRoute({
        recordedHref: '/(app)/agent-chat/ses_1',
        restoredRoute: '/agent-chat/ses_1',
      })
    ).toBe(false);
  });

  it('repairs a tab the OS restore did not reopen', () => {
    // Both are `/` once the root layout groups are stripped; the tab group is
    // the destination and must keep them apart.
    expect(
      shouldRepairRestoredRoute({
        recordedHref: '/(app)/(tabs)/(3_profile)',
        restoredRoute: '/(app)/(tabs)/(0_home)',
      })
    ).toBe(true);
  });

  it('does not repair when the recorded tab is already focused', () => {
    expect(
      shouldRepairRestoredRoute({
        recordedHref: '/(app)/(tabs)/(3_profile)',
        restoredRoute: '/(app)/(tabs)/(3_profile)',
      })
    ).toBe(false);
  });

  it('ignores a query string on the recorded href', () => {
    expect(
      shouldRepairRestoredRoute({
        recordedHref: '/(app)/agent-chat/ses_1?via=push',
        restoredRoute: '/agent-chat/ses_2',
      })
    ).toBe(true);
  });

  it('does not repair without a record', () => {
    expect(
      shouldRepairRestoredRoute({ recordedHref: null, restoredRoute: '/agent-chat/ses_gone' })
    ).toBe(false);
  });
});
