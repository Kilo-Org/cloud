import type { TRPCLink } from '@trpc/client';
import { observable } from '@trpc/server/observable';
import type { RootRouter } from '@/routers/root-router';
import {
  stepUpRequirementFromError,
  type StepUpRequirement,
} from '@/components/admin/step-up/step-up-error';

type StepUpHandler = (requirement: StepUpRequirement) => Promise<boolean>;

let handler: StepUpHandler | null = null;

export function registerStepUpHandler(next: StepUpHandler | null): void {
  handler = next;
}

/** Ask the mounted admin provider to verify; false when none is mounted. */
export async function verifyStepUpWithHandler(requirement: StepUpRequirement): Promise<boolean> {
  return handler ? handler(requirement) : false;
}

/**
 * When a tRPC operation refuses with `data.stepUp`, open the verification
 * dialog and retry that operation exactly once. Batched requests are retried
 * per operation. Cancelling or a bearer refusal leaves the original error to
 * surface normally.
 */
export function stepUpLink(): TRPCLink<RootRouter> {
  return () =>
    ({ op, next }) =>
      observable(observer => {
        let retried = false;
        let closed = false;
        let subscription: { unsubscribe: () => void } | undefined;

        const run = () => {
          if (closed) return;
          subscription = next(op).subscribe({
            next: value => observer.next(value),
            error: error => {
              const requirement = stepUpRequirementFromError(error);
              if (
                retried ||
                !handler ||
                !requirement ||
                requirement.code === 'BEARER_NOT_ALLOWED' ||
                op.path.startsWith('stepUp.')
              ) {
                observer.error(error);
                return;
              }
              retried = true;
              void handler(requirement).then(
                verified => {
                  if (closed) return;
                  if (verified) run();
                  else observer.error(error);
                },
                () => observer.error(error)
              );
            },
            complete: () => observer.complete(),
          });
        };

        run();
        return () => {
          closed = true;
          subscription?.unsubscribe();
        };
      });
}
