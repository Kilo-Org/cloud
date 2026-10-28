export type FirstChatCreationGuard = {
  /** Take the guard. False when a submission is already in flight. */
  tryBegin: () => boolean;
  end: () => void;
};

/**
 * A synchronous single-flight guard: two submissions in the same render would
 * each create a session. The ref-backed lock refuses the second one.
 */
export function createFirstChatCreationGuard(): FirstChatCreationGuard {
  let inFlight = false;
  return {
    tryBegin: () => {
      if (inFlight) return false;
      inFlight = true;
      return true;
    },
    end: () => {
      inFlight = false;
    },
  };
}
