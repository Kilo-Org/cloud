import { describe, expect, test } from '@jest/globals';
import { buildSetupPath, getInitialSetupState } from './setup-path';

describe('collab setup path', () => {
  test('pushes step two with personal workspace state', () => {
    expect(buildSetupPath({ stepIndex: 1, workspace: { type: 'personal' } })).toBe(
      '/collab?step=1'
    );
  });

  test('pushes step two with organization workspace state', () => {
    expect(
      buildSetupPath({
        stepIndex: 1,
        workspace: {
          type: 'org',
          id: '0c06733d-0f2c-42ec-921b-c312fb190427',
        },
      })
    ).toBe('/collab?step=1&organizationId=0c06733d-0f2c-42ec-921b-c312fb190427');
  });

  test('defaults step two to personal workspace when organization is not set', () => {
    const params = new URLSearchParams({ step: '1' });

    expect(getInitialSetupState(params)).toEqual({
      stepIndex: 1,
      workspace: { type: 'personal' },
    });
  });

  test('restores organization workspace state from URL', () => {
    const params = new URLSearchParams({
      step: '1',
      organizationId: '0c06733d-0f2c-42ec-921b-c312fb190427',
    });

    expect(getInitialSetupState(params)).toEqual({
      stepIndex: 1,
      workspace: { type: 'org', id: '0c06733d-0f2c-42ec-921b-c312fb190427' },
    });
  });
});
