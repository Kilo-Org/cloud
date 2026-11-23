/**
 * Negative type cases for the surface-feedback contract. The verdict comes from
 * `pnpm typecheck` (tsgo --noEmit), whose tsconfig includes every TypeScript
 * file in this app: each case below MUST fail to compile, and its
 * `@ts-expect-error` directive turns that failure into the check. These cases
 * carry no runtime assertion, because an expectation on an object literal
 * cannot fail once this file compiles.
 */
import { describe, it } from 'vitest';

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
    void missingKind;
  });

  it('requires the failure payload when an attempt fails', () => {
    const store = createSurfaceFeedbackStore<'key', Failure>();
    const attempt = store.begin('key');
    const misused = () => {
      // @ts-expect-error fail() must be given the failure it publishes
      attempt?.fail();
    };
    void misused;
    attempt?.abandon();
  });

  it('does not let a settlement result stand in for a phase', () => {
    const store = createSurfaceFeedbackStore<'key', Failure>();
    const admitted = store.begin('key');
    if (admitted === null) {
      throw new Error('a fresh store admits the first attempt for a key');
    }
    // @ts-expect-error succeed() reports ownership; it is not the surface's phase
    const phase: SurfaceFeedback<Failure> = admitted.succeed();
    void phase;
    admitted.abandon();
  });
});
