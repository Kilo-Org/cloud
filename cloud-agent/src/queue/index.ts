/**
 * Queue module for execution message processing.
 *
 * This module exports the queue consumer for handling
 * execution messages from Cloudflare Queues.
 *
 * IMPORTANT: This barrel file must NOT import from modules that depend on
 * @cloudflare/sandbox (consumer.js) to avoid breaking integration
 * tests that run in vitest-pool-workers.
 *
 * Production code should import directly from consumer.js for the full consumer.
 * Test code should import from consumer-core.js for the sandbox-free consumer.
 *
 * @example
 * ```ts
 * // Production - use direct import
 * import { createQueueConsumer } from './queue/consumer.js';
 *
 * // Tests - use direct import
 * import { createQueueConsumerWithDeps } from './queue/consumer-core.js';
 * ```
 */

// Re-export queue types (no sandbox dependencies)
export * from './types.js';

// Export core consumer (without sandbox dependencies - for tests)
export { createQueueConsumerWithDeps } from './consumer-core.js';

// NOTE: Do NOT export from './consumer.js' here!
// It imports @cloudflare/sandbox which cannot be resolved in vitest-pool-workers.
// Import directly from that file in production code.
