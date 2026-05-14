/**
 * libwl-runner: load and invoke the libwl WASM bundle.
 *
 * libwl.wasm is the wasteland Go SDK compiled to GOOS=js GOARCH=wasm. It
 * exposes wanted-board operations (browse, claim, done, etc.) as JS-
 * callable globals registered by the Go runtime via syscall/js.
 *
 * Lifecycle per call:
 * 1. Instantiate a fresh Go runtime + WASM instance.
 * 2. Kick off `go.run(instance)` — this returns a Promise that resolves
 *    when Go's `main()` exits. Our main blocks on `select{}`, so the
 *    Promise never resolves; we deliberately do not await it.
 * 3. After `go.run` yields back to JS (after `register()` has run), the
 *    eight `wl*` functions are present on globalThis.
 * 4. Invoke the requested function with a JSON string. It returns a
 *    Promise that resolves to a JSON string envelope: `{ ok, data?, error? }`.
 *
 * Concurrency note (POC): the Go runtime registers its bridge functions
 * on globalThis, so concurrent calls from different requests can race
 * each other's globals. For the POC we accept that risk and serialize
 * with `runQueue`. Production would either (a) move registration onto
 * the Go instance object, or (b) keep a long-lived isolate-wide
 * instance and submit work via a queue.
 *
 * Loading note: wasm_exec.js is a Go-supplied IIFE that sets
 * `globalThis.Go`. We import it for its side effect. Wrangler bundles
 * the .wasm file into the Worker; the import gives us a
 * WebAssembly.Module ready for instantiation.
 */

// Import for side effect — sets globalThis.Go.
import './wasm_exec.js';
// Wrangler treats .wasm imports as WebAssembly.Module (compiled but not
// instantiated). See https://developers.cloudflare.com/workers/runtime-apis/webassembly/javascript/
import libwlModule from './libwl.wasm';

// ── Types ───────────────────────────────────────────────────────────────

/**
 * Mirror of the eight `wl*` ops registered by wlwasm/js_bridge.go. Each
 * takes a JSON string and returns a Promise of a JSON string envelope.
 */
type LibwlGlobals = {
  wlBrowse(input: string): Promise<string>;
  wlClaim(input: string): Promise<string>;
  wlUnclaim(input: string): Promise<string>;
  wlDone(input: string): Promise<string>;
  wlPost(input: string): Promise<string>;
  wlAccept(input: string): Promise<string>;
  wlReject(input: string): Promise<string>;
  wlClose(input: string): Promise<string>;
};

export type LibwlOp = keyof LibwlGlobals;

type GoRuntime = {
  argv: string[];
  env: Record<string, string>;
  importObject: WebAssembly.Imports;
  exited: boolean;
  run(instance: WebAssembly.Instance): Promise<void>;
};

type GoConstructor = new () => GoRuntime;

// The Go IIFE sets globalThis.Go. Declare its type for TypeScript.
declare const Go: GoConstructor;

/**
 * Envelope returned by the Go bridge. Mirrors `jsResponse` in
 * wasteland/wlwasm/js_bridge.go:10-14.
 */
type Envelope<T> = { ok: true; data: T } | { ok: false; error: string };

// ── Single-flight queue ─────────────────────────────────────────────────
// POC: serialize calls because the Go runtime registers its bridge
// functions on globalThis. Two concurrent requests would clobber each
// other's wlBrowse/wlClaim/etc. references.

let runQueue: Promise<unknown> = Promise.resolve();

function enqueue<T>(work: () => Promise<T>): Promise<T> {
  const next = runQueue.then(work, work);
  // Swallow errors on the queue itself so one failed call doesn't poison
  // every subsequent call. Each caller still gets its own error via the
  // Promise chain it awaits.
  runQueue = next.catch(() => undefined);
  return next;
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Invoke a libwl op. The input object is JSON-serialized to the Go side;
 * the Go side returns a JSON envelope which we parse here.
 *
 * Throws if the Go side reports an error or if the runtime fails to
 * initialize. Callers should wrap in try/catch and translate to whatever
 * error contract their handler expects (e.g. WantedBoardOpError).
 */
export async function callLibwl<T>(op: LibwlOp, input: unknown): Promise<T> {
  return enqueue(async () => {
    const fn = await loadAndRegister(op);
    const raw = await fn(JSON.stringify(input));
    const envelope = JSON.parse(raw) as Envelope<T>;
    if (!envelope.ok) {
      throw new Error(`libwl ${op} failed: ${envelope.error}`);
    }
    return envelope.data;
  });
}

/**
 * Instantiate a fresh Go runtime + WASM instance and wait for the
 * requested function to be registered on globalThis.
 *
 * We do NOT await `go.run(instance)` because Go's main blocks on
 * `select{}`; awaiting would hang forever. Instead we kick off the run
 * loop, give it a microtask to set up its globals, then return the
 * captured function reference.
 */
async function loadAndRegister(op: LibwlOp): Promise<LibwlGlobals[LibwlOp]> {
  const go = new Go();
  const instance = await WebAssembly.instantiate(libwlModule, go.importObject);
  // Kick off the run loop. Don't await — main() blocks on select{}.
  // Errors from the runtime (e.g. unhandled panics) will surface on the
  // returned promise; capture them so they don't become unhandled
  // rejections.
  void go.run(instance).catch(err => {
    console.error('libwl Go runtime error:', err);
  });
  // Yield to the microtask queue so register() inside main() has a
  // chance to assign the wl* globals before we read them. One yield is
  // enough because syscall/js's FuncOf registration is synchronous from
  // Go's main goroutine.
  await Promise.resolve();
  const fn = (globalThis as unknown as LibwlGlobals)[op];
  if (typeof fn !== 'function') {
    throw new Error(`libwl ${op} not registered after wasm init`);
  }
  return fn.bind(globalThis);
}
