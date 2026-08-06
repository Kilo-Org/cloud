/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (node env, no jsdom); its React 19 deprecation notice points to the DOM-based Testing Library, which cannot render this app's non-DOM tree. See src/lib/persist/cache-persistence-mount.test.ts. */
import { StrictMode } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { useOwnedResource } from './use-owned-resource';

type Resource = { id: number };

let nextResourceId = 0;

function createResource(): Resource {
  const resource = { id: nextResourceId };
  nextResourceId += 1;
  return resource;
}

function Harness({
  create,
  destroy,
  onResource,
}: {
  create: () => Resource;
  destroy: (resource: Resource) => void;
  onResource: (resource: Resource) => void;
}) {
  const resource = useOwnedResource(create, destroy);
  onResource(resource);
  return null;
}

function mount(
  create: () => Resource,
  destroy: (resource: Resource) => void,
  replay = false
): {
  renderer: TestRenderer.ReactTestRenderer | undefined;
  resources: Resource[];
} {
  const resources: Resource[] = [];
  let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;
  const tree = (
    <Harness
      create={create}
      destroy={destroy}
      onResource={resource => {
        resources.push(resource);
      }}
    />
  );
  act(() => {
    // StrictMode replays mount effects (mount -> cleanup -> mount) in the
    // same tick, which is how a development double-mount surfaces here.
    renderer = TestRenderer.create(replay ? <StrictMode>{tree}</StrictMode> : tree);
  });
  return { renderer, resources };
}

async function flushTimers(): Promise<void> {
  await act(async () => {
    await new Promise(resolve => {
      setTimeout(resolve, 0);
    });
  });
}

describe('useOwnedResource', () => {
  it('keeps one resource and destroys nothing when the effect replays in the same tick', async () => {
    const create = vi.fn(createResource);
    const destroy = vi.fn<(resource: Resource) => void>();
    const { resources } = mount(create, destroy, true);

    expect(create).toHaveBeenCalledTimes(1);
    expect(destroy).not.toHaveBeenCalled();
    const first = resources[0];
    expect(first).toBeDefined();
    for (const resource of resources) {
      expect(resource).toBe(first);
    }

    // No deferred destroy may fire afterwards either: the replayed effect
    // cancelled the cleanup's timer in the same tick.
    await flushTimers();
    expect(destroy).not.toHaveBeenCalled();
  });

  it('destroys the resource exactly once after a real unmount', async () => {
    const create = vi.fn(createResource);
    const destroy = vi.fn<(resource: Resource) => void>();
    const { renderer } = mount(create, destroy);

    act(() => {
      renderer?.unmount();
    });
    expect(destroy).not.toHaveBeenCalled();

    await flushTimers();
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledWith(create.mock.results[0]?.value);
  });

  it('recreates a new resource on a later mount after the deferred destroy fired', async () => {
    const create = vi.fn(createResource);
    const destroy = vi.fn<(resource: Resource) => void>();
    const { renderer } = mount(create, destroy);

    act(() => {
      renderer?.unmount();
    });
    await flushTimers();
    expect(destroy).toHaveBeenCalledTimes(1);

    const { resources: laterResources } = mount(create, destroy);
    expect(create).toHaveBeenCalledTimes(2);
    const recreated = laterResources[0];
    expect(recreated).toBeDefined();
    expect(recreated).not.toBe(destroy.mock.calls[0]?.[0]);
  });
});
