/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer mounts the provider without native bridges. */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bumpAuthEpoch } from '@/lib/auth/auth-epoch';
import { OrganizationProvider, useOrganization } from '@/lib/organization-context';
import { waitFor } from '@/test/render-with-providers';

const auth = vi.hoisted(() => ({ token: 'token-a' as string | undefined }));
const storage = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), remove: vi.fn() }));
vi.mock('@/lib/auth/auth-context', () => ({ useAuth: () => auth }));
vi.mock('expo-secure-store', () => ({
  getItemAsync: storage.read,
  setItemAsync: storage.write,
  deleteItemAsync: storage.remove,
}));

let current: ReturnType<typeof useOrganization> | undefined = undefined;
const publications: { token: string | undefined; id: string | null; loaded: boolean }[] = [];
const writes: (string | null)[] = [];
const renderers: TestRenderer.ReactTestRenderer[] = [];

function Probe() {
  current = useOrganization();
  publications.push({ token: auth.token, id: current.organizationId, loaded: current.isLoaded });
  return createElement('Scope', current);
}

function scope() {
  if (!current) {
    throw new Error('provider did not publish');
  }
  return current;
}

const tree = () => createElement(OrganizationProvider, null, createElement(Probe));

async function mount() {
  const ref: { current?: TestRenderer.ReactTestRenderer } = {};
  await act(() => {
    ref.current = TestRenderer.create(tree());
  });
  if (!ref.current) {
    throw new Error('provider did not mount');
  }
  renderers.push(ref.current);
  return ref.current;
}

beforeEach(() => {
  auth.token = 'token-a';
  bumpAuthEpoch();
  current = undefined;
  publications.length = 0;
  writes.length = 0;
  storage.read.mockReset().mockResolvedValue(null);
  storage.write.mockReset().mockImplementation(async (_key: string, value: string) => {
    writes.push(value);
    await Promise.resolve(undefined);
  });
  storage.remove.mockReset().mockImplementation(async () => {
    writes.push(null);
    await Promise.resolve(undefined);
  });
});

afterEach(() => {
  act(() => {
    for (const renderer of renderers.splice(0)) {
      renderer.unmount();
    }
  });
});

describe('OrganizationProvider restoration', () => {
  it('never publishes Personal before a delayed saved organization', async () => {
    const read = Promise.withResolvers<string | null>();
    storage.read.mockReturnValue(read.promise);
    await mount();
    expect(scope().isLoaded).toBe(false);
    await act(() => {
      read.resolve('org-a');
    });
    expect(scope()).toMatchObject({ organizationId: 'org-a', isLoaded: true, error: null });
    expect(publications.some(value => value.loaded && value.id === null)).toBe(false);
  });

  it('resolves an absent stored value to Personal', async () => {
    await mount();
    expect(scope()).toMatchObject({ organizationId: null, isLoaded: true, error: null });
  });

  it('keeps a failed read unresolved and retries restoration', async () => {
    storage.read.mockRejectedValueOnce(new Error('read failed')).mockResolvedValue('org-a');
    await mount();
    expect(scope()).toMatchObject({ isLoaded: false, error: 'restore' });
    expect(publications.some(value => value.loaded)).toBe(false);
    await act(() => {
      scope().retry();
    });
    expect(scope()).toMatchObject({ organizationId: 'org-a', isLoaded: true, error: null });
  });

  it.each(['resolve', 'reject'])('ignores an obsolete read %s after selection', async outcome => {
    const read = Promise.withResolvers<string | null>();
    storage.read.mockReturnValue(read.promise);
    await mount();
    await act(() => {
      scope().setOrganizationId('org-b');
    });
    await act(() => {
      if (outcome === 'resolve') {
        read.resolve('org-a');
      } else {
        read.reject(new Error('obsolete'));
      }
    });
    expect(scope()).toMatchObject({ organizationId: 'org-b', isLoaded: true, error: null });
  });

  it('lets only the latest restoration retry publish', async () => {
    const oldRead = Promise.withResolvers<string | null>();
    const newRead = Promise.withResolvers<string | null>();
    storage.read.mockRejectedValueOnce(new Error('failed'));
    await mount();
    storage.read.mockReturnValueOnce(oldRead.promise).mockReturnValueOnce(newRead.promise);
    const retry = scope().retry;
    await act(() => {
      retry();
      retry();
    });
    await act(() => {
      newRead.resolve('org-b');
    });
    await act(() => {
      oldRead.resolve('org-a');
    });
    expect(scope()).toMatchObject({ organizationId: 'org-b', isLoaded: true, error: null });
  });

  it('does not reuse signed-out readiness when a token arrives', async () => {
    auth.token = undefined;
    const renderer = await mount();
    const read = Promise.withResolvers<string | null>();
    storage.read.mockReturnValue(read.promise);
    auth.token = 'token-b';
    await act(() => {
      renderer.update(tree());
    });
    expect(
      publications.filter(value => value.token === 'token-b').every(value => !value.loaded)
    ).toBe(true);
    await act(() => {
      read.resolve('org-b');
    });
    expect(scope().organizationId).toBe('org-b');
  });

  it('keeps the selected ID stable while a refreshed token restores the same context', async () => {
    storage.read.mockResolvedValueOnce('org-a');
    const renderer = await mount();
    const read = Promise.withResolvers<string | null>();
    storage.read.mockReturnValue(read.promise);
    auth.token = 'refreshed-token';
    await act(() => {
      renderer.update(tree());
    });
    expect(scope()).toMatchObject({ organizationId: 'org-a', isLoaded: false });
    await act(() => {
      read.resolve('org-a');
    });
    expect(
      publications
        .filter(value => value.token === 'refreshed-token')
        .every(value => value.id === 'org-a')
    ).toBe(true);
    expect(scope().isLoaded).toBe(true);
  });

  it.each(['token', 'epoch', 'unmount'])('ignores a read after %s invalidation', async reason => {
    const read = Promise.withResolvers<string | null>();
    storage.read.mockReturnValueOnce(read.promise).mockResolvedValue('org-b');
    const renderer = await mount();
    if (reason === 'token') {
      auth.token = 'token-b';
      await act(() => {
        renderer.update(tree());
      });
    } else if (reason === 'epoch') {
      bumpAuthEpoch();
    } else {
      act(() => {
        renderer.unmount();
      });
      await mount();
    }
    await act(() => {
      read.resolve('org-a');
    });
    expect(scope()).toMatchObject(
      reason === 'epoch'
        ? { organizationId: null, isLoaded: false, error: null }
        : { organizationId: 'org-b', isLoaded: true, error: null }
    );
  });
});

describe('OrganizationProvider persistence', () => {
  it.each([
    { id: 'org-a', fails: false },
    { id: 'org-a', fails: true },
    { id: null, fails: false },
    { id: null, fails: true },
  ])('keeps $id save Retry busy until storage settles (fails=$fails)', async ({ id, fails }) => {
    storage.read.mockResolvedValue('previous-org');
    await mount();
    const write = id === null ? storage.remove : storage.write;
    write.mockRejectedValueOnce(new Error('save failed'));
    await act(() => {
      scope().setOrganizationId(id);
    });
    await waitFor(() => scope().error === 'save');
    const save = Promise.withResolvers<undefined>();
    write.mockImplementationOnce(async (_key: string, value?: string) => {
      await save.promise;
      writes.push(value ?? null);
    });
    await act(() => {
      scope().retry();
    });
    expect(scope()).toMatchObject({
      organizationId: id,
      isLoaded: true,
      error: 'save',
      isSaving: true,
    });
    expect(writes).toEqual([]);
    await act(() => {
      if (fails) {
        save.reject(new Error('retry failed'));
      } else {
        save.resolve(undefined);
      }
    });
    await waitFor(() => !scope().isSaving);
    expect(scope()).toMatchObject({ organizationId: id, error: fails ? 'save' : null });
    expect(writes).toEqual(fails ? [] : [id]);
  });

  it.each(['org-b', null])('retries the latest selection %s, not a failed snapshot', async id => {
    await mount();
    storage.write.mockRejectedValueOnce(new Error('save failed'));
    await act(() => {
      scope().setOrganizationId('org-a');
    });
    await waitFor(() => scope().error === 'save');
    const retry = scope().retry;
    await act(() => {
      scope().setOrganizationId(id);
      retry();
    });
    await waitFor(() => writes.length === 2);
    expect(writes).toEqual([id, id]);
    expect(scope()).toMatchObject({
      organizationId: id,
      isLoaded: true,
      error: null,
      isSaving: false,
    });
  });

  describe.each(['resolve', 'reject'])('obsolete save %s', outcome => {
    it.each([
      { reason: 'selection', expected: 'org-b', isSaving: true },
      { reason: 'token', expected: null, isSaving: false },
      { reason: 'epoch', expected: 'org-a', isSaving: true },
      { reason: 'unmount', expected: null, isSaving: false },
    ])('ignores completion after $reason invalidation', async ({ reason, expected, isSaving }) => {
      const renderer = await mount();
      const save = Promise.withResolvers<undefined>();
      const newerSave = Promise.withResolvers<undefined>();
      storage.write.mockReturnValueOnce(save.promise).mockReturnValueOnce(newerSave.promise);
      await act(() => {
        scope().setOrganizationId('org-a');
      });
      if (reason === 'selection') {
        await act(() => {
          scope().setOrganizationId('org-b');
        });
      } else if (reason === 'token') {
        auth.token = undefined;
        await act(() => {
          renderer.update(tree());
        });
      } else if (reason === 'epoch') {
        bumpAuthEpoch();
      } else {
        act(() => {
          renderer.unmount();
        });
        await mount();
      }
      await act(() => {
        if (outcome === 'resolve') {
          save.resolve(undefined);
        } else {
          save.reject(new Error('obsolete'));
        }
      });
      expect(scope()).toMatchObject({ organizationId: expected, error: null, isSaving });
      await act(() => {
        newerSave.resolve(undefined);
      });
    });
  });
});
