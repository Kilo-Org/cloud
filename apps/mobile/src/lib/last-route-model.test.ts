import { describe, expect, it } from 'vitest';

import { isRecordableLastRoute } from './last-route-recordable';
import { shouldRepairRestoredRoute } from './last-route-repair';

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
});

describe('shouldRepairRestoredRoute', () => {
  it('repairs when the record differs from the restored route', () => {
    expect(
      shouldRepairRestoredRoute({
        recordedHref: '/(app)/(tabs)/(3_profile)/profiles/p1/variables',
        restoredPathname: '/agent-chat/ses_gone',
      })
    ).toBe(true);
  });

  it('does not repair when the OS restore already reopened the recorded screen', () => {
    expect(
      shouldRepairRestoredRoute({
        recordedHref: '/(app)/agent-chat/ses_1',
        restoredPathname: '/agent-chat/ses_1',
      })
    ).toBe(false);
  });

  it('ignores a query string on the recorded href', () => {
    expect(
      shouldRepairRestoredRoute({
        recordedHref: '/(app)/agent-chat/ses_1?via=push',
        restoredPathname: '/agent-chat/ses_2',
      })
    ).toBe(true);
  });

  it('does not repair without a record', () => {
    expect(
      shouldRepairRestoredRoute({ recordedHref: null, restoredPathname: '/agent-chat/ses_gone' })
    ).toBe(false);
  });
});
