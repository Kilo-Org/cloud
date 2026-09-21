import { vi } from 'vitest';

// The mobile vitest projects run with no app build, so `@/lib/config` cannot
// load: its real module needs the baked `extra`. Tests that exercise modules
// importing it (the auth retry helpers and everything built on them) would
// otherwise fail before their first assertion.
//
// A Proxy answers every export Vitest resolves, and an unset value keeps the
// build-gated E2E windows closed. A test that needs a config value still mocks
// this module itself; its later registration wins over this one.
vi.mock('@/lib/config', () => new Proxy({}, { get: () => undefined, has: () => true }));
