import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { getSandboxNamespace, getOutboundContainerId } from './sandbox-id.js';
import {
  resolveSandboxIdClass,
  resolveSandboxNamespace,
  selectControlPlaneSandbox,
  type SandboxKind,
} from './sandbox-placement.js';
import {
  assertSandboxBillingAllocation,
  SANDBOX_USAGE_SKUS,
  type SandboxClassName,
} from './container-usage-context.js';
import type { Env, SandboxId } from './types.js';

const SESSION_ID = 'workspace_420ae020-e3c4-4e67-878b-66672c3d997e';
const OTHER_SESSION_ID = 'workspace_00000000-0000-4000-8000-000000000000';
const PLACED_ID = `sbx-${'a'.repeat(48)}` as SandboxId;

/** Each binding is a distinct sentinel so a test can see which pool was chosen. */
const namespaceEnv = Object.fromEntries(
  [
    'Sandbox',
    'SandboxContainment',
    'SandboxSmallContainment',
    'SandboxCodeReviewContainment',
    'SandboxDIND',
  ].map(name => [name, { binding: name, idFromName: (id: string) => `${name}:${id}` }])
) as unknown as Env;

/** The legacy prefixed key that encoded each kind before the stored kind existed. */
const LEGACY_KEY: Record<SandboxKind, SandboxId> = {
  isolated: `ses-${'a'.repeat(48)}`,
  'code-review': `crv-${'a'.repeat(48)}`,
  shared: `usr-${'a'.repeat(48)}`,
};

function sha256Key(input: string): string {
  return `sbx-${createHash('sha256').update(input).digest('hex').slice(0, 48)}`;
}

function billingInput(sandboxKind: SandboxKind) {
  return {
    sandboxId: PLACED_ID,
    subject: { type: 'user', id: 'user-1' },
    actor: { type: 'user', id: 'user-1' },
    ...(sandboxKind === 'shared'
      ? {}
      : { sessionId: SESSION_ID, metadata: { origin: 'cloud-agent' } }),
  } as const;
}

const KINDS = ['isolated', 'code-review', 'shared'] as const;
const CONTAINMENT = [true, false] as const;

describe('placed key parity with the legacy prefix table', () => {
  // The pool sets SKU, capacity and price, so a placed key must land exactly
  // where its legacy-prefixed equivalent did. Local e2e runs uncontained and
  // isolated only, so this is the only coverage for contained and shared pools.
  it.each(KINDS.flatMap(kind => CONTAINMENT.map(contained => ({ kind, contained }))))(
    'routes $kind (contained=$contained) to the legacy pool',
    ({ kind, contained }) => {
      expect(
        resolveSandboxNamespace(namespaceEnv, {
          sandboxId: PLACED_ID,
          sandboxKind: kind,
          contained,
        })
      ).toBe(
        getSandboxNamespace(namespaceEnv, LEGACY_KEY[kind], { managedScmContainment: contained })
      );
    }
  );

  it.each(KINDS)('bills %s in exactly the pools its legacy key bills in', kind => {
    for (const className of Object.keys(SANDBOX_USAGE_SKUS) as SandboxClassName[]) {
      const legacy = () =>
        assertSandboxBillingAllocation(className, {
          ...billingInput(kind),
          sandboxId: LEGACY_KEY[kind],
        });
      const placed = () =>
        assertSandboxBillingAllocation(className, { ...billingInput(kind), sandboxKind: kind });
      let legacyAccepted = true;
      try {
        legacy();
      } catch {
        legacyAccepted = false;
      }
      if (legacyAccepted) expect(placed).not.toThrow();
      else expect(placed).toThrow();
    }
  });
});

describe('selectControlPlaneSandbox', () => {
  it('isolates a session by default, whatever the per-session org list says', async () => {
    for (const env of [{}, { PER_SESSION_SANDBOX_ORG_IDS: 'org-1' }]) {
      const decision = await selectControlPlaneSandbox({
        env,
        sessionId: SESSION_ID,
        userId: 'user-1',
        orgId: 'org-2',
        codeReview: false,
      });

      expect(decision).toEqual({
        sandboxId: sha256Key(`control-isolated-v1:${SESSION_ID}`),
        provider: 'cloudflare',
        sandboxKind: 'isolated',
      });
    }
  });

  it('derives one deterministic shared key per owner and bot', async () => {
    const select = (sessionId: string, input: { orgId?: string; botId?: string }) =>
      selectControlPlaneSandbox({
        env: {},
        sessionId,
        userId: 'user-1',
        ...input,
        codeReview: false,
        sandboxAllocation: 'cloudflare-shared',
      });

    const first = await select(SESSION_ID, { orgId: 'org-1' });
    const second = await select(OTHER_SESSION_ID, { orgId: 'org-1' });
    const bot = await select(SESSION_ID, { orgId: 'org-1', botId: 'bot-1' });
    const personal = await select(SESSION_ID, {});

    expect(first).toEqual({
      sandboxId: sha256Key('control-shared-v2:org-1__user-1'),
      provider: 'cloudflare',
      sandboxKind: 'shared',
    });
    expect(second.sandboxId).toBe(first.sandboxId);
    expect(bot.sandboxId).toBe(sha256Key('control-shared-v2:org-1__user-1__bot:bot-1'));
    expect(personal.sandboxId).toBe(sha256Key('control-shared-v2:user:user-1__user-1'));
  });

  it('isolates code review per session on Cloudflare', async () => {
    const decision = await selectControlPlaneSandbox({
      env: { CLOUDFLARE_CONTAINERS_ORG_IDS: '*' },
      sessionId: SESSION_ID,
      userId: 'user-1',
      orgId: 'org-1',
      codeReview: true,
    });

    expect(decision).toEqual({
      sandboxId: sha256Key(`control-isolated-v1:${SESSION_ID}`),
      provider: 'cloudflare',
      sandboxKind: 'code-review',
    });
  });

  it.each([
    ['cloudflare-single', 'cloudflare', 'isolated'],
    ['cloudflare-shared', 'cloudflare', 'shared'],
    ['vercel-small', 'vercel', 'isolated'],
    ['cloudflare-containers-standard-3', 'cloudflare-containers', 'isolated'],
  ] as const)('places an explicit %s allocation', async (allocation, provider, sandboxKind) => {
    const decision = await selectControlPlaneSandbox({
      env: {},
      sessionId: SESSION_ID,
      userId: 'user-1',
      orgId: 'org-1',
      codeReview: false,
      sandboxAllocation: allocation,
    });

    expect(decision.provider).toBe(provider);
    expect(decision.sandboxKind).toBe(sandboxKind);
  });

  it('enrols a default isolated session in Cloudflare Containers', async () => {
    const decision = await selectControlPlaneSandbox({
      env: { CLOUDFLARE_CONTAINERS_ORG_IDS: '*' },
      sessionId: SESSION_ID,
      userId: 'user-1',
      codeReview: false,
    });

    expect(decision.provider).toBe('cloudflare-containers');
    expect(decision.sandboxKind).toBe('isolated');
  });

  it.each([
    [{ codeReview: true, sandboxAllocation: 'cloudflare-single' as const }, /specialized/],
    [{ codeReview: false, sandboxAllocation: 'isolated-standard' as const }, /Isolated Standard/],
  ])('rejects an unsupported allocation %j', async (input, message) => {
    await expect(
      selectControlPlaneSandbox({
        env: {},
        sessionId: SESSION_ID,
        userId: 'user-1',
        ...input,
      })
    ).rejects.toThrow(message);
  });
});

describe('placed key fail-closed routing', () => {
  it('rejects a placed key in the legacy prefix table', () => {
    for (const contained of CONTAINMENT) {
      expect(() =>
        getSandboxNamespace(namespaceEnv, PLACED_ID, { managedScmContainment: contained })
      ).toThrow('A placed sandbox key routes only through its stored kind');
      expect(() =>
        getOutboundContainerId(namespaceEnv, PLACED_ID, { managedScmContainment: contained })
      ).toThrow('A placed sandbox key routes only through its stored kind');
      expect(() =>
        resolveSandboxNamespace(namespaceEnv, { sandboxId: PLACED_ID, contained })
      ).toThrow('A placed sandbox key routes only through its stored kind');
    }
  });

  it('rejects a placed key without its kind and a legacy key with one', () => {
    expect(() => resolveSandboxIdClass({ sandboxId: PLACED_ID })).toThrow(
      'Sandbox key and kind do not match'
    );
    expect(() =>
      resolveSandboxIdClass({ sandboxId: LEGACY_KEY.isolated, sandboxKind: 'isolated' })
    ).toThrow('Sandbox key and kind do not match');
  });

  it('keeps routing legacy keys by prefix', () => {
    expect(
      resolveSandboxNamespace(namespaceEnv, { sandboxId: LEGACY_KEY.isolated, contained: true })
    ).toBe(namespaceEnv.SandboxSmallContainment);
    expect(resolveSandboxIdClass({ sandboxId: LEGACY_KEY['code-review'] })).toBe('code-review');
  });
});
