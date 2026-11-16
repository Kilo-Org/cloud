import { describe, expect, it } from '@jest/globals';
import {
  APP_SHELL_EXPIRED_PATH,
  APP_SHELL_PREFIX,
  appShellTargetSchema,
  buildAppShellIntegrationPath,
  buildAppShellSignInPath,
  buildAppShellTargetPath,
  isAppShellPath,
  isAppShellPlatform,
} from './shell-paths';

const ORGANIZATION_ID = '00000000-0000-4000-8000-000000000001';

describe('buildAppShellTargetPath', () => {
  it('builds the personal GitHub install page', () => {
    expect(buildAppShellTargetPath({ page: 'github-app' })).toBe('/app-shell/github-app');
  });

  it('builds the organization GitHub install page', () => {
    expect(buildAppShellTargetPath({ page: 'github-app', organizationId: ORGANIZATION_ID })).toBe(
      `/app-shell/github-app?organizationId=${ORGANIZATION_ID}`
    );
  });

  it('builds both integration shapes', () => {
    expect(buildAppShellTargetPath({ page: 'integration', platform: 'slack' })).toBe(
      '/app-shell/integrations/slack'
    );
    expect(
      buildAppShellTargetPath({
        page: 'integration',
        platform: 'gitlab',
        organizationId: ORGANIZATION_ID,
      })
    ).toBe(`/app-shell/organizations/${ORGANIZATION_ID}/integrations/gitlab`);
  });

  it('builds the account and organization card pages', () => {
    expect(buildAppShellTargetPath({ page: 'connected-accounts' })).toBe(
      '/app-shell/connected-accounts'
    );
    expect(buildAppShellTargetPath({ page: 'organization-sso', organizationId: ORGANIZATION_ID })).toBe(
      `/app-shell/organizations/${ORGANIZATION_ID}/sso`
    );
    expect(
      buildAppShellTargetPath({
        page: 'organization-data-collection',
        organizationId: ORGANIZATION_ID,
      })
    ).toBe(`/app-shell/organizations/${ORGANIZATION_ID}/data-collection`);
  });

  it('produces only paths the shell owns', () => {
    const targets: Parameters<typeof buildAppShellTargetPath>[0][] = [
      { page: 'github-app' },
      { page: 'github-app', organizationId: ORGANIZATION_ID },
      { page: 'integration', platform: 'slack' },
      { page: 'integration', platform: 'gitlab', organizationId: ORGANIZATION_ID },
      { page: 'connected-accounts' },
      { page: 'organization-sso', organizationId: ORGANIZATION_ID },
      { page: 'organization-data-collection', organizationId: ORGANIZATION_ID },
    ];

    for (const target of targets) {
      expect(isAppShellPath(buildAppShellTargetPath(target))).toBe(true);
    }
  });
});

describe('appShellTargetSchema', () => {
  it('refuses a page the shell does not host', () => {
    expect(appShellTargetSchema.safeParse({ page: 'credits' }).success).toBe(false);
  });

  it('refuses a provider the shell does not host', () => {
    expect(appShellTargetSchema.safeParse({ page: 'integration', platform: 'bitbucket' }).success).toBe(
      false
    );
    expect(appShellTargetSchema.safeParse({ page: 'integration', platform: 'dolthub' }).success).toBe(
      false
    );
  });

  it('refuses a malformed organization id', () => {
    expect(
      appShellTargetSchema.safeParse({ page: 'github-app', organizationId: '../../credits' }).success
    ).toBe(false);
  });
});

describe('isAppShellPath', () => {
  it('accepts shell paths and refuses everything else', () => {
    expect(isAppShellPath('/app-shell')).toBe(true);
    expect(isAppShellPath('/app-shell/github-app')).toBe(true);
    expect(isAppShellPath('/credits')).toBe(false);
    expect(isAppShellPath('/app-shellx')).toBe(false);
    expect(isAppShellPath('/app-shell/../credits')).toBe(false);
    expect(isAppShellPath('//evil.example/app-shell')).toBe(false);
    expect(isAppShellPath('/app-shell\\..\\credits')).toBe(false);
  });
});

describe('buildAppShellIntegrationPath', () => {
  it('falls back to the terminal page for a provider the shell does not host', () => {
    expect(buildAppShellIntegrationPath('bitbucket')).toBe(APP_SHELL_EXPIRED_PATH);
    expect(isAppShellPlatform('bitbucket')).toBe(false);
  });
});

describe('buildAppShellSignInPath', () => {
  it('carries the email and the callback path inside the shell', () => {
    const path = buildAppShellSignInPath({
      email: 'owner@example.com',
      callbackPath: '/device-auth?code=ABCD-1234&app=1',
    });

    expect(path.startsWith(`${APP_SHELL_PREFIX}/sign-in?`)).toBe(true);
    const params = new URL(path, 'https://kilo.invalid').searchParams;
    expect(params.get('email')).toBe('owner@example.com');
    expect(params.get('callbackPath')).toBe('/device-auth?code=ABCD-1234&app=1');
  });
});
