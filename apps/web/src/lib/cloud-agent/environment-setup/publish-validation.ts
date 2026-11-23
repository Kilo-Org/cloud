import type { EnvironmentRepositoryEntry } from '@kilocode/cloud-agent-profile';
import { assertAllocationSupportsMultiRepository } from '@/lib/cloud-agent/multi-repository-environments';

export function assertDraftPublishable(draft: {
  repositories?: readonly EnvironmentRepositoryEntry[] | null;
  sandboxAllocation: string | null;
}): void {
  if ((draft.repositories?.length ?? 0) > 1) {
    assertAllocationSupportsMultiRepository(draft.sandboxAllocation);
  }
}
