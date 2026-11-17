import { useKeyedSurfaceFeedback } from '@/lib/hooks/use-surface-feedback';
import { organizationErrorMessage } from '@/lib/server-error-copy';

/**
 * A refused member removal, stated on the row the confirm ran for.
 *
 * The removal's optimistic update drops the row while its request runs, so the
 * row's own mutation hook dies with it and a rollback remounts a fresh hook
 * with no error state. The screen owns this store instead: the entry is keyed
 * by the member id and survives the unmount, so the remounted row reads the
 * refusal that belongs to it.
 */
export type MemberRemovalFailure = {
  readonly kind: 'removal-refused';
  /** The localized explanation, mapped from the server's rejection. */
  readonly message: string;
};

/** The keyed store one members screen owns: one attempt per member at a time. */
export type MemberRemovalStore = {
  readonly snapshot: ReturnType<
    typeof useKeyedSurfaceFeedback<string, MemberRemovalFailure>
  >['snapshot'];
  readonly begin: ReturnType<typeof useKeyedSurfaceFeedback<string, MemberRemovalFailure>>['begin'];
  /** Retires the member's shown refusal, leaving a pending attempt alone. */
  readonly clear: ReturnType<
    typeof useKeyedSurfaceFeedback<string, MemberRemovalFailure>
  >['clearWhere'];
};

export function useMemberRemovalFeedback(): MemberRemovalStore {
  const store = useKeyedSurfaceFeedback<string, MemberRemovalFailure>();
  return {
    snapshot: store.snapshot,
    begin: store.begin,
    clear: store.clearWhere,
  };
}

/** The localized explanation for a removal the server refused. */
export function removalRefusalMessage(error: unknown): MemberRemovalFailure['message'] {
  return organizationErrorMessage(error);
}
