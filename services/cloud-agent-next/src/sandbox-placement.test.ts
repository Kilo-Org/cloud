import { describe, expect, it } from 'vitest';
import { getSandboxNamespace, getOutboundContainerId } from './sandbox-id.js';
import {
  resolveSandboxIdClass,
  resolveSandboxNamespace,
  type SandboxKind,
} from './sandbox-placement.js';
import {
  assertSandboxBillingAllocation,
  SANDBOX_USAGE_SKUS,
  type SandboxClassName,
} from './container-usage-context.js';
import type { Env, SandboxId } from './types.js';

const SESSION_ID = 'workspace_420ae020-e3c4-4e67-878b-66672c3d997e';
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
