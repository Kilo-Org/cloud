/**
 * `BufferSource` is a DOM / Web Worker type. This Worker's tsconfig (`esnext` + node types) does
 * not declare it, but `@kilocode/sts-contracts`, reached through `@kilocode/secrets-client`,
 * enqueues one into a `ReadableStream` when it compresses an audit body. The Workers runtime
 * provides the value; only the type is missing here.
 *
 * `worker-configuration.d.ts` in this package is hand-written. Running `pnpm types` replaces it
 * with wrangler's output, which carries the workerd runtime types (this alias included): delete
 * this file in the same change.
 */
type BufferSource = ArrayBufferView | ArrayBuffer;
