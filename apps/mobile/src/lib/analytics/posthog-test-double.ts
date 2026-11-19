// Shared `posthog-react-native` test double for the analytics and telemetry
// suites. Lives in a plain `.ts` module on purpose: vitest collects only
// `*.test.ts` files, so this helper never runs as a suite.
//
// Hoisting shape probed under vitest 5.1.0 (works):
//   const posthogTestDouble = vi.hoisted(() => ({ ... }));
//   export { posthogTestDouble };
// The mocker rejects `export const x = vi.hoisted(...)` with a SyntaxError
// ("Cannot export hoisted variable"), so the hoisted object must bind with a
// plain `const` and be exported separately.
//
// Per-file isolation: every importing test file gets its own instance of these
// doubles. The helper re-evaluates once per test file, and a `vi.mock` factory
// body may reach the imported doubles because it runs lazily, while a
// file-local `vi.hoisted` factory cannot (an imported binding resolves only
// after the rewritten `await import(...)` of this helper executes — later than
// the hoisted calls). Merging happens at file scope with `Object.assign` so
// each suite's existing `hoisted.client`-style references keep working without
// renames; its own `vi.mock` factories stay in the suites.

import { vi } from 'vitest';

/** Constructor options recorded by the last `new PostHog()` call. */
type PostHogHolder = { options?: Record<string, unknown> };

const posthogTestDouble = vi.hoisted(() => {
  const client = {
    register: vi.fn(),
    setPersonPropertiesForFlags: vi.fn(),
    onFeatureFlags: vi.fn(),
    capture: vi.fn(),
    screen: vi.fn(),
    identify: vi.fn(),
    reloadFeatureFlags: vi.fn(),
    getFeatureFlag: vi.fn(),
    reset: vi.fn(),
    setPersistedProperty: vi.fn(),
    optOut: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn(),
    flush: vi.fn(),
  };

  const holder: PostHogHolder = {};

  const controller = {
    allowsMandatory: vi.fn().mockReturnValue(true),
    allowsOptional: vi.fn().mockReturnValue(true),
    currentGeneration: vi.fn().mockReturnValue(0),
  };

  const storage = {
    sealPostHogStorage: vi.fn(),
    unsealPostHogStorage: vi.fn(),
    purgePostHogPersistence: vi.fn(),
    // oxlint-disable-next-line consistent-type-assertions -- mock must match PostHogCustomStorage interface
    posthogCustomStorage: {} as Record<string, unknown>,
  };

  return { client, holder, controller, storage };
});

/** The SDK's `PostHogPersistedProperty` keys, mirrored by the suites' mock. */
const postHogPersistedProperty = {
  Queue: 'queue',
  LogsQueue: 'logs_queue',
  AiQueue: 'ai_queue',
} as const;

/** Shared `new PostHog()` constructor mock, recording the options it receives. */
const posthogMockConstructor = vi.fn(function PostHogMock(
  _key: string,
  options: Record<string, unknown>
) {
  posthogTestDouble.holder.options = options;
  return posthogTestDouble.client;
});

/**
 * Fresh controller double. Defaults match `posthog.test.ts` and the
 * feature-flag suite (`true`/`true`/`0`); `no-sdk-before-decision` passes
 * `false`/`false` to hold both gates closed.
 */
function createControllerDouble(
  options: {
    mandatory?: boolean;
    optional?: boolean;
    generation?: number;
  } = {}
) {
  const { mandatory = true, optional = true, generation = 0 } = options;
  return {
    allowsMandatory: vi.fn().mockReturnValue(mandatory),
    allowsOptional: vi.fn().mockReturnValue(optional),
    currentGeneration: vi.fn().mockReturnValue(generation),
  };
}

export {
  posthogMockConstructor,
  posthogTestDouble,
  createControllerDouble,
  postHogPersistedProperty,
};
