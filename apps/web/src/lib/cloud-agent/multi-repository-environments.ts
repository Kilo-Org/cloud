import {
  allocationSupportsMultiRepository,
  sandboxAllocationSchema,
} from '@kilocode/worker-utils/sandbox-allocation';
import { TRPCError } from '@trpc/server';

/**
 * A V2 session needs a sandbox that one session owns: one workspace holds every
 * repository. A saved retired shared sandbox is rejected when the environment
 * is saved. An unset allocation is checked when the session starts.
 */
export function assertAllocationSupportsMultiRepository(
  allocation: string | null | undefined
): void {
  if (allocation === null || allocation === undefined) return;
  const parsed = sandboxAllocationSchema.safeParse(allocation);
  if (!parsed.success || !allocationSupportsMultiRepository(parsed.data)) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'A multi-repository environment cannot run on the shared sandbox',
    });
  }
}
