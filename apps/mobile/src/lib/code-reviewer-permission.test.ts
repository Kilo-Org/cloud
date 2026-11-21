import { describe, expect, it, vi } from 'vitest';

import { classifyPermission } from './code-reviewer-status';

// A permission read that has not answered must stay unresolved. The role alone
// cannot say whether the caller may act: an owner reads as `neither capability`
// while the org list is paused, and screens would then refuse an action the
// role does allow. These cases live apart from the classifier's other suites to
// keep each file under the line limit.
describe('classifyPermission with a read that has not answered', () => {
  it('is loading, not read-only, while the org list is paused with no data', () => {
    // A paused query (offline/unknown connectivity, empty cache) is pending but
    // not fetching, so isLoading is false while the role is still unknown.
    expect(
      classifyPermission({
        isPersonal: false,
        isLoading: false,
        isError: false,
        isFetching: false,
        hasData: false,
        role: undefined,
        refetch: vi.fn<() => void>(),
      })
    ).toEqual({ status: 'loading' });
  });

  it('keeps a failed read as an error even before any data arrives', () => {
    expect(
      classifyPermission({
        isPersonal: false,
        isLoading: false,
        isError: true,
        isFetching: false,
        hasData: false,
        role: undefined,
        refetch: vi.fn<() => void>(),
      })
    ).toMatchObject({ status: 'error' });
  });

  it('reads a loaded list that omits the scope as neither capability', () => {
    expect(
      classifyPermission({
        isPersonal: false,
        isLoading: false,
        isError: false,
        isFetching: false,
        hasData: true,
        role: undefined,
        refetch: vi.fn<() => void>(),
      })
    ).toEqual({ status: 'ready', canEdit: false, canManage: false });
  });
});
