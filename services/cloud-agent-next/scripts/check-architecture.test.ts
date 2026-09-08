import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeArchitecture, type ArchitectureViolation } from './check-architecture.js';

const owner = `export async function preflightSessionCreation(request: unknown) { return request; }
export function profileResolutionPolicyForSessionCreateOrigin() { return {}; }
export function resolveEffectiveSessionConfiguration(request: unknown) { return request; }
export function assertModeAvailableForProfile() {}
`;
const registration = `export async function registerNewSession(request: unknown) { return request; }
export async function startNewSession(request: unknown) { return request; }
export async function createSessionWithLedger(request: unknown) {
  return startNewSession(request);
}
`;
const startHandler = `import { preflightSessionCreation as admit } from './preflight-barrel.js';
import { startNewSession as register } from '../../session/session-registration.js';
function withLogTags(_tags: unknown, callback: () => unknown) { return callback(); }
export async function start(request: unknown) {
  return withLogTags({}, async () => {
    const admitted = await admit(request);
    return register(admitted);
  });
}
`;
const prepareHandler = `import { preflightSessionCreation } from './session-creation-preflight.js';
import { createSessionWithLedger, registerNewSession, startNewSession } from '../../session/session-registration.js';
function withLogTags(_tags: unknown, callback: () => unknown) { return callback(); }
export async function prepare(request: unknown, autoInitiate: boolean, operationKey?: string) {
  return withLogTags({}, async () => {
    const admitted = await preflightSessionCreation(request);
    return autoInitiate && operationKey
      ? createSessionWithLedger(admitted)
      : autoInitiate
        ? startNewSession(admitted)
        : registerNewSession(admitted);
  });
}
`;

function baseFiles(): Record<string, string> {
  return {
    'src/router/handlers/session-creation-preflight.ts': owner,
    'src/router/handlers/preflight-barrel.ts':
      "export { preflightSessionCreation } from './session-creation-preflight.js';\n",
    'src/router/handlers/session-start.ts': startHandler,
    'src/router/handlers/session-prepare.ts': prepareHandler,
    'src/session/session-registration.ts': registration,
    'src/model-validation.ts': 'export function assertKiloModelAvailable() {}\n',
    'src/session/validate-repository-access.ts':
      'export function assertRepositoryAccessBeforeSessionCreation() {}\n',
    'src/router/handlers/organization-membership.ts':
      'export function assertOrganizationMembership() {}\n',
    'src/shared/protocol.ts': 'export type Protocol = string;\n',
  };
}

async function fixture(
  changes: Record<string, string>,
  run: (violations: ArchitectureViolation[], root: string) => void | Promise<void>
) {
  const root = await mkdtemp(join(tmpdir(), 'cloud-agent-architecture-test-'));
  try {
    const files = { ...baseFiles(), ...changes };
    for (const [name, content] of Object.entries(files)) {
      const file = join(root, name);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, content);
    }
    await run(await analyzeArchitecture(root), root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function messages(violations: readonly ArchitectureViolation[]): string {
  return violations.map(violation => `${violation.rule}: ${violation.message}`).join('\n');
}

describe('creation ownership architecture', () => {
  it('accepts aliased/re-exported owner use and the production withLogTags prepare ternary', async () => {
    await fixture({}, violations => expect(violations).toEqual([]));
  });

  it.each([
    [
      'skipped preflight',
      `import { startNewSession } from '../../session/session-registration.js';
       export async function start(request: unknown) { return startNewSession(request); }`,
      'must call preflightSessionCreation',
    ],
    [
      'unused owner import',
      `import { preflightSessionCreation } from './session-creation-preflight.js';
       import { startNewSession } from '../../session/session-registration.js';
       export async function start(request: unknown) { return startNewSession(request); }`,
      'import alone is not sufficient',
    ],
    [
      'unresolved request registration',
      `import { preflightSessionCreation } from './session-creation-preflight.js';
       import { startNewSession } from '../../session/session-registration.js';
       export async function start(request: unknown) {
         const admitted = await preflightSessionCreation(request);
         return startNewSession(request);
       }`,
      'exact unshadowed preflight result',
    ],
    [
      'conditional preflight',
      `import { preflightSessionCreation } from './session-creation-preflight.js';
       import { startNewSession } from '../../session/session-registration.js';
       export async function start(request: unknown, condition: boolean) {
         let admitted = request;
         if (condition) { admitted = await preflightSessionCreation(request); }
         return startNewSession(admitted);
       }`,
      'unconditional const binding',
    ],
    [
      'preflight in deeper callback',
      `import { preflightSessionCreation } from './session-creation-preflight.js';
       import { startNewSession } from '../../session/session-registration.js';
       export async function start(request: unknown) {
         const admitted = await Promise.resolve().then(() => preflightSessionCreation(request));
         return startNewSession(admitted);
       }`,
      'unconditional const binding',
    ],
    [
      'preflight outside the executing body',
      `import { preflightSessionCreation } from './session-creation-preflight.js';
       import { startNewSession } from '../../session/session-registration.js';
       function withLogTags(callback: () => unknown) { return callback(); }
       export async function start(request: unknown) {
         const admitted = await preflightSessionCreation(request);
         return withLogTags(async () => startNewSession(admitted));
       }`,
      'unconditional preflight result',
    ],
    [
      'overwritten admitted result',
      `import { preflightSessionCreation } from './session-creation-preflight.js';
       import { startNewSession } from '../../session/session-registration.js';
       export async function start(request: unknown) {
         const admitted = await preflightSessionCreation(request);
         admitted = request;
         return startNewSession(admitted);
       }`,
      'must not be overwritten',
    ],
    [
      'restored original profile after preflight',
      `import { preflightSessionCreation } from './session-creation-preflight.js';
       import { startNewSession } from '../../session/session-registration.js';
       export async function start(request: any) {
         const admitted = await preflightSessionCreation(request);
         admitted.profile = request.profile;
         return startNewSession(admitted);
       }`,
      'must not be overwritten',
    ],
    [
      'restored original agent through a nested element write',
      `import { preflightSessionCreation } from './session-creation-preflight.js';
       import { startNewSession } from '../../session/session-registration.js';
       export async function start(request: any) {
         const admitted = await preflightSessionCreation(request);
         admitted['profile'].resolved.runtimeAgents[0] = request.profile.resolved.runtimeAgents[0];
         return startNewSession(admitted);
       }`,
      'must not be overwritten',
    ],
    [
      'deleted admitted profile data',
      `import { preflightSessionCreation } from './session-creation-preflight.js';
       import { startNewSession } from '../../session/session-registration.js';
       export async function start(request: any) {
         const admitted = await preflightSessionCreation(request);
         delete admitted.profile.resolved;
         return startNewSession(admitted);
       }`,
      'must not be overwritten',
    ],
    [
      'shadowed admitted result',
      `import { preflightSessionCreation } from './session-creation-preflight.js';
       import { startNewSession } from '../../session/session-registration.js';
       export async function start(request: unknown) {
         const admitted = await preflightSessionCreation(request);
         { const admitted = request; return startNewSession(admitted); }
       }`,
      'exact unshadowed preflight result',
    ],
  ])('rejects %s', async (_name, replacement, expected) => {
    await fixture({ 'src/router/handlers/session-start.ts': replacement }, violations => {
      expect(messages(violations)).toContain(expected);
    });
  });

  it('rejects direct and re-exported low-level admission imports', async () => {
    const direct = `import { preflightSessionCreation } from './session-creation-preflight.js';
import { assertKiloModelAvailable } from '../../model-validation.js';
import { startNewSession } from '../../session/session-registration.js';
export async function start(request: unknown) {
  assertKiloModelAvailable();
  const admitted = await preflightSessionCreation(request);
  return startNewSession(admitted);
}`;
    await fixture({ 'src/router/handlers/session-start.ts': direct }, violations => {
      expect(messages(violations)).toContain(
        'imports low-level admission symbol assertKiloModelAvailable'
      );
    });

    const reexported = `import { preflightSessionCreation } from './session-creation-preflight.js';
import { checkModel } from './low-level-barrel.js';
import { startNewSession } from '../../session/session-registration.js';
export async function start(request: unknown) {
  checkModel();
  const admitted = await preflightSessionCreation(request);
  return startNewSession(admitted);
}`;
    await fixture(
      {
        'src/router/handlers/session-start.ts': reexported,
        'src/router/handlers/low-level-barrel.ts':
          "export { assertKiloModelAvailable as checkModel } from '../../model-validation.js';\n",
      },
      violations => {
        expect(messages(violations)).toContain(
          'imports low-level admission symbol assertKiloModelAvailable'
        );
      }
    );

    const profileResolver = `import { preflightSessionCreation } from './session-creation-preflight.js';
import { mergeProfileConfiguration as resolveProfile } from '@kilocode/cloud-agent-profile';
import { startNewSession } from '../../session/session-registration.js';
export async function start(request: unknown) {
  resolveProfile;
  const admitted = await preflightSessionCreation(request);
  return startNewSession(admitted);
}`;
    await fixture({ 'src/router/handlers/session-start.ts': profileResolver }, violations => {
      expect(messages(violations)).toContain(
        'imports low-level profile resolver mergeProfileConfiguration'
      );
    });

    const packageReexport = `import { preflightSessionCreation } from './session-creation-preflight.js';
import { resolveProfile } from './profile-package-barrel.js';
import { startNewSession } from '../../session/session-registration.js';
export async function start(request: unknown) {
  resolveProfile;
  const admitted = await preflightSessionCreation(request);
  return startNewSession(admitted);
}`;
    await fixture(
      {
        'src/router/handlers/session-start.ts': packageReexport,
        'src/router/handlers/profile-package-barrel.ts':
          "export { mergeProfileConfiguration as resolveProfile } from '@kilocode/cloud-agent-profile';\n",
        'node_modules/@kilocode/cloud-agent-profile/index.d.ts':
          'export declare function mergeProfileConfiguration(): unknown;\n',
      },
      violations => {
        expect(messages(violations)).toContain(
          'imports low-level profile resolver mergeProfileConfiguration'
        );
      }
    );
  });

  it('rejects direct-package and local-barrel dynamic low-level admission imports', async () => {
    const packageImport = `import { preflightSessionCreation } from './session-creation-preflight.js';
import { startNewSession } from '../../session/session-registration.js';
export async function start(request: unknown) {
  const profile = await import('@kilocode/cloud-agent-profile');
  await profile.mergeProfileConfiguration();
  const admitted = await preflightSessionCreation(request);
  return startNewSession(admitted);
}`;
    await fixture(
      {
        'src/router/handlers/session-start.ts': packageImport,
        'node_modules/@kilocode/cloud-agent-profile/index.d.ts':
          'export declare function mergeProfileConfiguration(): unknown;\n',
      },
      violations => {
        expect(messages(violations)).toContain(
          'imports low-level profile resolver mergeProfileConfiguration'
        );
      }
    );

    const profileBarrelImport = `import { preflightSessionCreation } from './session-creation-preflight.js';
import { startNewSession } from '../../session/session-registration.js';
export async function start(request: unknown) {
  const profile = await import('./profile-package-barrel.js');
  await profile.resolveProfile();
  const admitted = await preflightSessionCreation(request);
  return startNewSession(admitted);
}`;
    await fixture(
      {
        'src/router/handlers/session-start.ts': profileBarrelImport,
        'src/router/handlers/profile-package-barrel.ts':
          "export { mergeProfileConfiguration as resolveProfile } from '@kilocode/cloud-agent-profile';\n",
        'node_modules/@kilocode/cloud-agent-profile/index.d.ts':
          'export declare function mergeProfileConfiguration(): unknown;\n',
      },
      violations => {
        expect(messages(violations)).toContain(
          'imports low-level profile resolver mergeProfileConfiguration'
        );
      }
    );

    const admissionBarrelImport = `import { preflightSessionCreation } from './session-creation-preflight.js';
import { startNewSession } from '../../session/session-registration.js';
export async function start(request: unknown) {
  const checks = await import('./all-low-level-barrel.js');
  checks.checkOrganization();
  const admitted = await preflightSessionCreation(request);
  return startNewSession(admitted);
}`;
    await fixture(
      {
        'src/router/handlers/session-start.ts': admissionBarrelImport,
        'src/router/handlers/all-low-level-barrel.ts': `export { assertKiloModelAvailable as checkModel } from '../../model-validation.js';
export { assertRepositoryAccessBeforeSessionCreation as checkRepository } from '../../session/validate-repository-access.js';
export { assertOrganizationMembership as checkOrganization } from './organization-membership.js';\n`,
      },
      violations => {
        const output = messages(violations);
        expect(output).toContain('imports low-level admission symbol assertKiloModelAvailable');
        expect(output).toContain(
          'imports low-level admission symbol assertRepositoryAccessBeforeSessionCreation'
        );
        expect(output).toContain('imports low-level admission symbol assertOrganizationMembership');
      }
    );
  });

  it('rejects indirect and aliased registration callers outside the two handlers', async () => {
    await fixture(
      {
        'src/helper.ts': `import { startNewSession as bypass } from './session/session-registration.js';
export function helper(request: unknown) { return bypass(request); }`,
      },
      violations => {
        expect(messages(violations)).toContain('may be called only by the creation handlers');
      }
    );
  });

  it.each([
    [
      'namespace property access',
      `import * as registration from './session/session-registration.js';
export function helper(request: unknown) { return registration.startNewSession(request); }`,
      'may be called only by the creation handlers',
    ],
    [
      'literal namespace element access',
      `import * as registration from './session/session-registration.js';
export function helper(request: unknown) { return registration['startNewSession'](request); }`,
      'may be called only by the creation handlers',
    ],
    [
      'shorthand namespace destructuring',
      `import * as registration from './session/session-registration.js';
const { startNewSession } = registration;
export function helper(request: unknown) { return startNewSession(request); }`,
      'must not be destructured, aliased, or passed',
    ],
    [
      'computed namespace element access',
      `import * as registration from './session/session-registration.js';
export function helper(name: string, request: unknown) { return registration[name](request); }`,
      'must not be destructured, aliased, or passed',
    ],
  ])('rejects registration through %s', async (_name, source, expected) => {
    await fixture({ 'src/helper.ts': source }, violations => {
      expect(messages(violations)).toContain(expected);
    });
  });

  it.each([
    [
      'a local alias',
      `import { startNewSession } from './session/session-registration.js';
const create = startNewSession;
export function helper(request: unknown) { return create(request); }`,
    ],
    [
      'a passed reference',
      `import { startNewSession } from './session/session-registration.js';
function invoke(callback: (request: unknown) => unknown, request: unknown) { return callback(request); }
export function helper(request: unknown) { return invoke(startNewSession, request); }`,
    ],
  ])('rejects registration functions used through %s', async (_name, source) => {
    await fixture({ 'src/helper.ts': source }, violations => {
      expect(messages(violations)).toContain('local aliases and passed references are not allowed');
    });
  });
});

describe('worker-wrapper source ownership', () => {
  it('accepts wrapper imports from src/shared', async () => {
    await fixture(
      { 'wrapper/src/valid.ts': "import type { Protocol } from '../../src/shared/protocol.js';\n" },
      violations => expect(violations).toEqual([])
    );
  });

  it('rejects wrapper-to-worker and worker-to-wrapper production imports', async () => {
    await fixture(
      {
        'src/worker-bypass.ts': "import '../wrapper/src/wrapper-only.js';\n",
        'wrapper/src/wrapper-only.ts': 'export const wrapperOnly = true;\n',
        'wrapper/src/wrapper-bypass.ts': "import '../../src/model-validation.js';\n",
      },
      violations => {
        const output = messages(violations);
        expect(output).toContain(
          'Wrapper production code may import Worker code only from src/shared'
        );
        expect(output).toContain('Worker production code must not import wrapper code');
      }
    );
  });

  it('rejects literal dynamic imports in both worker-wrapper directions', async () => {
    await fixture(
      {
        'src/dynamic-worker-bypass.ts':
          "export const wrapper = import('../wrapper/src/wrapper-only.js');\n",
        'wrapper/src/wrapper-only.ts': 'export const wrapperOnly = true;\n',
        'wrapper/src/dynamic-wrapper-bypass.ts':
          "export const worker = import('../../src/model-validation.js');\n",
      },
      violations => {
        const output = messages(violations);
        expect(output).toContain(
          'Wrapper production code may import Worker code only from src/shared'
        );
        expect(output).toContain('Worker production code must not import wrapper code');
      }
    );
  });

  it('excludes tests, specs, and fixture paths from the production scan', async () => {
    const forbidden = `import { startNewSession } from './session-registration.js';
startNewSession({});`;
    await fixture(
      {
        'src/session/bypass.test.ts': forbidden,
        'src/session/bypass.spec.ts': forbidden,
        'src/session/bypass-fixture.ts': forbidden,
        'src/fixtures/bypass.ts': forbidden,
        'src/__snapshots__/bypass.ts': forbidden,
        'src/recordings/bypass.ts': forbidden,
        'wrapper/src/bypass.test.ts': "import '../../src/model-validation.js';\n",
      },
      violations => expect(violations).toEqual([])
    );
  });
});
