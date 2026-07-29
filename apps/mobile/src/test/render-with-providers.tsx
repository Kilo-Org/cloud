/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (node env, no jsdom); its React 19 deprecation notice points to the DOM-based Testing Library, which cannot render this app's non-DOM tree, and @testing-library/react-native (which itself wraps react-test-renderer) cannot be transformed by the current vitest pipeline (react-native ships Flow). */
import { type ComponentType, createElement, type ReactElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import TestRenderer, { act } from 'react-test-renderer';

/**
 * Mounted-test harness for the mobile app's data layer.
 *
 * The app's runtime provider stack (see `src/components/app-root-providers.tsx`)
 * is GestureHandlerRootView -> TRPCProvider -> QueryClientProvider ->
 * QueryClientNativeLifecycle -> AuthProvider -> OrganizationProvider ->
 * ActionSheetProvider -> PortalHost. TanStack Query (`QueryClientProvider`) is
 * the minimal provider needed to exercise data-fetching behavior, so it is the
 * default here.
 *
 * Rendering uses `react-test-renderer`, which is DOM-free (no jsdom): the mounted
 * tests run in a `node` environment. This harness deliberately does NOT statically
 * import the app's TRPC/Auth/Organization providers: those pull in `react-native`,
 * whose Flow-typed source the vitest (rolldown) transform cannot currently parse.
 * Callers that need extra providers pass a `wrapper` component; when an RN-capable
 * transform is available, real app providers can be dropped in through it.
 */

type RenderWithProvidersOptions = {
  /** Reuse a specific client (e.g. to seed cache); defaults to a fresh test client. */
  queryClient?: QueryClient;
  /** Optional extra provider composition wrapped inside `QueryClientProvider`. */
  wrapper?: ComponentType<{ children: ReactNode }>;
};

type RenderWithProvidersResult = {
  renderer: TestRenderer.ReactTestRenderer;
  queryClient: QueryClient;
  /** Unmount the tree and clear the query cache. */
  unmount: () => void;
};

/**
 * Build a `QueryClient` configured for deterministic tests: retries disabled so a
 * rejected query surfaces immediately, and no background refetching.
 */
export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
}

/**
 * Mount `ui` inside `QueryClientProvider` (plus an optional caller `wrapper`) using
 * `react-test-renderer`, flushing effects within `act`. Returns the renderer and the
 * `QueryClient` so tests can assert async state.
 */
export async function renderWithProviders(
  ui: ReactElement,
  options: RenderWithProvidersOptions = {}
): Promise<RenderWithProvidersResult> {
  const queryClient = options.queryClient ?? createTestQueryClient();
  const Wrapper = options.wrapper;

  const inner = Wrapper ? createElement(Wrapper, null, ui) : ui;
  const tree = createElement(QueryClientProvider, { client: queryClient }, inner);

  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    ref.current = TestRenderer.create(tree);
    await Promise.resolve();
  });
  const created = ref.current;
  if (!created) {
    throw new Error('renderWithProviders: renderer was not created');
  }

  return {
    renderer: created,
    queryClient,
    unmount: () => {
      act(() => {
        created.unmount();
      });
      queryClient.clear();
    },
  };
}

/**
 * Repeatedly flush effects until `predicate` returns true or the attempt budget is
 * exhausted. Each attempt is wrapped in `act`, so state updates from settling
 * queries are applied before the next check. Throws if the predicate never holds.
 */
export async function waitFor(predicate: () => boolean, attempts = 50): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) {
      return;
    }
    // Yield to the macrotask queue (not just microtasks): TanStack Query flushes
    // observer notifications through its scheduler, so a bare `Promise.resolve()`
    // can loop without ever observing the settled query.
    // eslint-disable-next-line no-await-in-loop -- polling must flush and re-check sequentially between act cycles
    await act(async () => {
      await new Promise(resolve => {
        setTimeout(resolve, 0);
      });
    });
  }
  if (!predicate()) {
    throw new Error(`waitFor: condition not met after ${attempts} attempts`);
  }
}
