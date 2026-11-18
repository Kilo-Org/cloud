import { describe, expect, it } from 'vitest';
import {
  ISOLATED_CONTAINER_WORKSPACE_PATH,
  NonIsolatedMultiRepositoryWorkspaceError,
  environmentWorkspace,
  environmentWorkspaceDirectory,
  isMultiRepositoryEnvironment,
  rootPathPrefix,
} from './environment-workspace.js';

const SHARED_DIRECTORY = '/workspace/usr/user_1/sessions/workspace_1';

const api = { leaf: 'api', repoFullName: 'acme/api', branch: 'kilo/s' };
const web = { leaf: 'web', repoFullName: 'acme/web', branch: 'feature/x' };

describe('environmentWorkspace', () => {
  it.each([
    ['no environment', null, ISOLATED_CONTAINER_WORKSPACE_PATH],
    ['a V1 environment', {}, ISOLATED_CONTAINER_WORKSPACE_PATH],
    ['no environment on a shared sandbox', null, SHARED_DIRECTORY],
    ['a V1 environment on a shared sandbox', {}, SHARED_DIRECTORY],
  ])('keeps the session directory for %s', (_label, environment, sessionDirectory) => {
    expect(environmentWorkspace({ sessionDirectory, environment })).toEqual({
      cwd: sessionDirectory,
      roots: [{ directory: sessionDirectory, repository: null, branch: undefined, launch: true }],
    });
  });

  it('puts a one-repository V2 environment at /workspace/<leaf>, also when the leaf is app', () => {
    for (const leaf of ['api', 'app']) {
      const member = { ...api, leaf };
      expect(
        environmentWorkspace({
          sessionDirectory: ISOLATED_CONTAINER_WORKSPACE_PATH,
          environment: { repositories: [member] },
          isLaunch: () => true,
        })
      ).toEqual({
        cwd: `/workspace/${leaf}`,
        roots: [
          { directory: `/workspace/${leaf}`, repository: member, branch: 'kilo/s', launch: true },
        ],
      });
    }
  });

  it('puts every repository of a several-repository V2 environment under /workspace', () => {
    expect(
      environmentWorkspace({
        sessionDirectory: ISOLATED_CONTAINER_WORKSPACE_PATH,
        environment: { repositories: [api, web] },
        isLaunch: member => member.leaf === 'web',
      })
    ).toEqual({
      cwd: '/workspace',
      roots: [
        { directory: '/workspace/api', repository: api, branch: 'kilo/s', launch: false },
        { directory: '/workspace/web', repository: web, branch: 'feature/x', launch: true },
      ],
    });
  });

  it('marks no root as the launch root without a launch predicate', () => {
    const { roots } = environmentWorkspace({
      sessionDirectory: ISOLATED_CONTAINER_WORKSPACE_PATH,
      environment: { repositories: [api, web] },
    });
    expect(roots.map(root => root.launch)).toEqual([false, false]);
  });

  it.each([[[api]], [[api, web]]])(
    'refuses a V2 environment on a session directory that is not the isolated one (%#)',
    repositories => {
      expect(() =>
        environmentWorkspace({
          sessionDirectory: SHARED_DIRECTORY,
          environment: { repositories },
        })
      ).toThrow(NonIsolatedMultiRepositoryWorkspaceError);
    }
  );

  it('gives the cwd alone through environmentWorkspaceDirectory', () => {
    expect(
      environmentWorkspaceDirectory({
        sessionDirectory: ISOLATED_CONTAINER_WORKSPACE_PATH,
        environment: { repositories: [api, web] },
      })
    ).toBe('/workspace');
    expect(
      environmentWorkspaceDirectory({
        sessionDirectory: SHARED_DIRECTORY,
        environment: null,
      })
    ).toBe(SHARED_DIRECTORY);
  });
});

describe('isMultiRepositoryEnvironment', () => {
  it('is true for any V2 environment, one repository included', () => {
    expect(isMultiRepositoryEnvironment({ repositories: [api] })).toBe(true);
    expect(isMultiRepositoryEnvironment({ repositories: [api, web] })).toBe(true);
  });

  it('is false for a V1 environment and for none', () => {
    expect(isMultiRepositoryEnvironment({ repository: 'x' } as { repositories?: unknown })).toBe(
      false
    );
    expect(isMultiRepositoryEnvironment(null)).toBe(false);
    expect(isMultiRepositoryEnvironment(undefined)).toBe(false);
  });
});

describe('rootPathPrefix', () => {
  it('is empty when the root is the cwd, which a one-repository environment has', () => {
    expect(rootPathPrefix('/workspace/web', '/workspace/web')).toBe('');
  });

  it('is the leaf of a root below the multi-repository cwd', () => {
    expect(rootPathPrefix('/workspace', '/workspace/web')).toBe('web');
    expect(rootPathPrefix('/workspace/', '/workspace/api')).toBe('api');
  });

  it('refuses a root that is not inside the cwd, including a sibling that shares its prefix', () => {
    expect(() => rootPathPrefix('/workspace/web', '/workspace/website')).toThrow();
    expect(() => rootPathPrefix('/workspace', '/other/web')).toThrow();
  });
});
