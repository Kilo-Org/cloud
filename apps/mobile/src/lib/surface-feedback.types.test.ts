/**
 * Negative type cases for the surface-feedback contract. They are checked by
 * `pnpm typecheck`, whose tsconfig includes every TypeScript file; the runtime
 * assertions only keep the file meaningful to vitest.
 */
import { describe, expect, it } from 'vitest';

import {
  createSurfaceFeedbackStore,
  type SurfaceFailure,
  type SurfaceFeedback,
} from '@/lib/surface-feedback';

type Failure = { readonly kind: 'boom'; readonly message: string };

describe('surface feedback types', () => {
  it('requires a kind on a failure payload', () => {
    // @ts-expect-error a failure MUST carry the `kind` discriminator views switch on
    const missingKind: SurfaceFailure = { message: 'no kind' };
    expect(missingKind).toBeDefined();
  });

  it('requires the failure payload when an attempt fails', () => {
    const store = createSurfaceFeedbackStore<'key', Failure>();
    const attempt = store.begin('key');
    const misused = () => {
      // @ts-expect-error fail() must be given the failure it publishes
      attempt?.fail();
    };
    expect(misused).toBeTypeOf('function');
    attempt?.abandon();
  });

  it('does not let a settlement result stand in for a phase', () => {
    const store = createSurfaceFeedbackStore<'key', Failure>();
    const attempt = store.begin('key');
    // @ts-expect-error succeed() reports ownership; it is not the surface's phase
    const phase: SurfaceFeedback<Failure> = attempt?.succeed();
    expect(phase).toBeDefined();
  });
});
