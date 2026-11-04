import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  resolveSandboxIdClass,
  selectControlPlaneSandbox,
  type SandboxKind,
} from './sandbox-placement.js';
import {
  assertSandboxBillingAllocation,
  SANDBOX_USAGE_SKUS,
  type SandboxClassName,
} from './container-usage-context.js';
import type { SandboxId } from './types.js';

const SESSION_ID = 'workspace_420ae020-e3c4-4e67-878b-66672c3d997e';
const OTHER_SESSION_ID = 'workspace_00000000-0000-4000-8000-000000000000';
const PLACED_ID = `sbx-${'a'.repeat(48)}` as SandboxId;

/** The legacy prefixed key that encoded each kind before the stored kind existed. */
const LEGACY_KEY: Record<SandboxKind, SandboxId> = {
  isolated: `ses-${'a'.repeat(48)}`,
  'isolated-standard': `istd-${'a'.repeat(48)}`,
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

const KINDS = ['isolated', 'isolated-standard', 'code-review', 'shared'] as const;

describe('placed key billing parity with the legacy prefix table', () => {
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
    const envCases = [{}, { PER_SESSION_SANDBOX_ORG_IDS: 'org-1' }];
    for (const env of envCases) {
      const decision = await selectControlPlaneSandbox({
        env,
        sessionId: SESSION_ID,
        userId: 'user-1',
        orgId: 'org-2',
        codeReview: false,
      });

      expect(decision).toEqual({
        sandboxId: sha256Key(`control-isolated-v1:${SESSION_ID}`),
        provider: 'cloudflare-containers',
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

  it.each([{}, { CLOUDFLARE_CONTAINERS_ORG_IDS: '*' }])(
    'defaults code review to Cloudflare Containers regardless of enrollment: %j',
    async env => {
      const decision = await selectControlPlaneSandbox({
        env,
        sessionId: SESSION_ID,
        userId: 'user-1',
        orgId: 'org-1',
        codeReview: true,
      });

      expect(decision).toEqual({
        sandboxId: sha256Key(`control-isolated-v1:${SESSION_ID}`),
        provider: 'cloudflare-containers',
        sandboxKind: 'code-review',
      });
    }
  );

  it.each([
    ['cloudflare-single', 'cloudflare', 'isolated'],
    ['isolated-standard', 'cloudflare', 'isolated-standard'],
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

  it.each([{}, { CLOUDFLARE_CONTAINERS_ORG_IDS: '*' }] as const)(
    'defaults an isolated session to Cloudflare Containers regardless of enrollment: %j',
    async env => {
      const decision = await selectControlPlaneSandbox({
        env,
        sessionId: SESSION_ID,
        userId: 'user-1',
        codeReview: false,
      });

      expect(decision.provider).toBe('cloudflare-containers');
      expect(decision.sandboxKind).toBe('isolated');
    }
  );

  it('keeps a code-review kind when the resolved default allocation is native', async () => {
    const decision = await selectControlPlaneSandbox({
      env: {},
      sessionId: SESSION_ID,
      userId: 'user-1',
      codeReview: true,
      sandboxAllocation: 'cloudflare-containers-standard-3',
    });

    expect(decision.provider).toBe('cloudflare-containers');
    expect(decision.sandboxKind).toBe('code-review');
  });

  it('rejects an explicit allocation combined with code-review routing', async () => {
    await expect(
      selectControlPlaneSandbox({
        env: {},
        sessionId: SESSION_ID,
        userId: 'user-1',
        codeReview: true,
        sandboxAllocation: 'cloudflare-containers-standard-3',
        requestedAllocation: 'cloudflare-single',
      })
    ).rejects.toThrow('specialized');
  });
});

describe('placed key fail-closed routing', () => {
  it('rejects a placed key without its kind and a legacy key with one', () => {
    expect(() => resolveSandboxIdClass({ sandboxId: PLACED_ID })).toThrow(
      'Sandbox key and kind do not match'
    );
    expect(() =>
      resolveSandboxIdClass({ sandboxId: LEGACY_KEY.isolated, sandboxKind: 'isolated' })
    ).toThrow('Sandbox key and kind do not match');
  });

  it('keeps historical legacy keys decodable by prefix', () => {
    expect(resolveSandboxIdClass({ sandboxId: LEGACY_KEY.isolated })).toBe('isolated-small');
    expect(resolveSandboxIdClass({ sandboxId: LEGACY_KEY['code-review'] })).toBe('code-review');
    expect(resolveSandboxIdClass({ sandboxId: LEGACY_KEY.shared })).toBe('shared');
  });
});
