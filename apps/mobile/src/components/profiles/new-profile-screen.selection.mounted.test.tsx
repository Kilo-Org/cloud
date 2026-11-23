import { beforeEach, describe, expect, it } from 'vitest';

import {
  boundaryRefetch,
  boundaryState,
  createMutate,
  findCreateButton,
  findRetryRow,
  mount,
  pressCreate,
  resetNewProfileState,
  selectionRetry,
  typeName,
} from '@/components/profiles/new-profile-screen.mounted.test-helpers';
import { waitFor } from '@/test/render-with-providers';
import { act } from '@/test/renderer';

/**
 * The stored organization selection publishes an organization only once it
 * settles. Until then the screen has no answer about the scope, so a create
 * that could belong to an organization waits for it; a settled Personal scope
 * is an answer and keeps its immediate create.
 */
describe('NewProfileScreen stored selection', () => {
  beforeEach(resetNewProfileState);

  it('holds the create while the stored selection may still name an organization', async () => {
    boundaryState.organizationId = null;
    boundaryState.role = undefined;
    boundaryState.org = undefined;
    boundaryState.orgs = undefined;
    boundaryState.isResolving = true;
    boundaryState.selectionSettled = false;
    const { renderer, rerender, unmount } = await mount();

    expect(findCreateButton(renderer.root).props.disabled).toBe(true);
    // The selection settles on its own, so it offers no retry of its own.
    expect(findRetryRow(renderer.root)).toBeUndefined();

    typeName(renderer.root, 'Backend debugging');
    await pressCreate(renderer.root);
    expect(createMutate).not.toHaveBeenCalled();

    boundaryState.orgs = [];
    boundaryState.isResolving = false;
    boundaryState.selectionSettled = true;
    rerender();

    expect(findCreateButton(renderer.root).props.disabled).toBe(false);
    await pressCreate(renderer.root);

    await waitFor(() => createMutate.mock.calls.length > 0);
    expect(createMutate.mock.calls[0]?.[0]).toEqual({ name: 'Backend debugging' });

    unmount();
  });

  it('offers the create at once once the selection settled on Personal', async () => {
    boundaryState.organizationId = null;
    boundaryState.role = undefined;
    boundaryState.org = undefined;
    boundaryState.orgs = [];
    const { renderer, unmount } = await mount();

    expect(findCreateButton(renderer.root).props.disabled).toBe(false);

    typeName(renderer.root, 'Backend debugging');
    await pressCreate(renderer.root);

    await waitFor(() => createMutate.mock.calls.length > 0);
    expect(createMutate.mock.calls[0]?.[0]).toEqual({ name: 'Backend debugging' });

    unmount();
  });

  it('offers the retry row when the stored selection could not be read', async () => {
    boundaryState.organizationId = null;
    boundaryState.role = undefined;
    boundaryState.org = undefined;
    boundaryState.orgs = undefined;
    boundaryState.isResolving = true;
    boundaryState.selectionSettled = false;
    boundaryState.selectionError = 'restore';
    const { renderer, unmount } = await mount();

    expect(findCreateButton(renderer.root).props.disabled).toBe(true);

    const retryRow = findRetryRow(renderer.root);
    if (!retryRow) {
      throw new Error('selection retry row was not rendered');
    }
    act(() => {
      (retryRow.props as { onRetry: () => void }).onRetry();
    });
    expect(selectionRetry).toHaveBeenCalledOnce();
    expect(boundaryRefetch).not.toHaveBeenCalled();

    unmount();
  });
});
