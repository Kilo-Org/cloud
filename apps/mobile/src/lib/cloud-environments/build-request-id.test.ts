import { describe, expect, it } from 'vitest';

import { createBuildRequestIds } from './build-request-id';

function counter() {
  let count = 0;
  return () => {
    count += 1;
    return `id-${count}`;
  };
}

describe('createBuildRequestIds', () => {
  it('reuses the id of an attempt that has not been answered', () => {
    // A retry after a lost response must name the same attempt, or the server
    // starts a second build (or answers `build_in_progress` for the first).
    const createId = counter();
    const ids = createBuildRequestIds(createId);

    const first = ids.forAttempt('env', 1);
    expect(first).toBe('id-1');
    expect(ids.forAttempt('env', 1)).toBe(first);
  });

  it('starts a new attempt once the previous one was answered', () => {
    const ids = createBuildRequestIds(counter());

    const first = ids.forAttempt('env', 1);
    ids.answered('env', 1);
    const second = ids.forAttempt('env', 1);
    expect(second).not.toBe(first);
    expect(second).toBe('id-2');
  });

  it('keeps environments and revisions apart', () => {
    const ids = createBuildRequestIds(counter());

    const attempt = ids.forAttempt('env-a', 1);
    expect(ids.forAttempt('env-b', 1)).not.toBe(attempt);
    expect(ids.forAttempt('env-a', 2)).not.toBe(attempt);
    // Answering another attempt leaves this one in place.
    ids.answered('env-b', 1);
    expect(ids.forAttempt('env-a', 1)).toBe(attempt);
  });
});
