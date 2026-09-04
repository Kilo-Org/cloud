/**
 * What a consumer imports.
 *
 * The modules a caller uses whole are re-exported whole. The eight below are not:
 * they hold the machinery a session runs on, and a caller who reads `history`
 * has no use for `wiringFor`, `makeId` or `sinceSummary`. Everything left out
 * here is still reachable from `@kilocode/harness-sdk/core`, which is the whole
 * of the core and is where a plugin author goes.
 *
 * `conformance.ts` is not here either, and for a different reason: `checkStore`
 * and `checkAssembler` are run by a plugin author in their own test suite, and
 * nobody runs them in production. Three hundred lines in the entry every
 * consumer imports is three hundred lines every consumer bundles. They live at
 * `@kilocode/harness-sdk/testing`, and in `/core` with the rest.
 *
 * `plugins/fetch` is left out for the same kind of reason, the other way round:
 * a caller who brings their own adapter should not carry this one.
 */

export type { AskOptions } from './core/ask.js';
export { SessionBusyError } from './core/ask.js';
export * from './core/catalog.js';
export * from './core/entropy.js';
export * from './core/fetch.js';
export * from './core/model.js';
export * from './core/prompt.js';
export type { Answering, Continued, Waiting } from './core/queue.js';
export * from './core/retry.js';
export * from './core/resume.js';
export * from './core/run.js';
export type { SessionStoreService, StoredSession } from './core/storage.js';
export { SessionStore, StoreError } from './core/storage.js';
export * from './core/token.js';
export type {
  JsonSchema,
  Tool,
  ToolCall,
  ToolDefinition,
  ToolRegistryService,
  ToolResult,
} from './core/tool.js';
export { ToolFailure, ToolMissingError, ToolRegistry } from './core/tool.js';
export type { Session } from './core/session.js';
export type { PartDraft, Turn, TurnPart, TurnRole } from './core/turn.js';
export { textOf } from './core/turn.js';
export type { SessionHandle } from './core/handle.js';
export type { SessionContext, SessionOptions } from './core/wiring.js';
export { hitRatio } from './core/usage.js';
export * from './plugins/catalog/table.js';
export * from './plugins/entropy/seeded.js';
export * from './plugins/entropy/web-crypto.js';
export * from './plugins/gateway/index.js';
export * from './plugins/kilo.js';
export * from './plugins/prompt/default.js';
export * from './plugins/retry/backoff.js';
export * from './plugins/token/static.js';
export * from './plugins/tools/index.js';
