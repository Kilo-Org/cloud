// Ambient declarations for non-TS imports used by the libwl runner.
//
// Wrangler bundles `.wasm` files as `WebAssembly.Module` (the binary is
// compiled but not instantiated; you call `WebAssembly.instantiate(mod, ...)`
// at runtime). The Go-supplied `wasm_exec.js` is a side-effecting IIFE
// that sets `globalThis.Go`; we import it for its side effect, so the
// module shape itself is unknown / unused.

declare module '*.wasm' {
  const wasmModule: WebAssembly.Module;
  export default wasmModule;
}

declare module './wasm_exec.js' {
  // Importing for side effect only; no exports we care about.
  const _: unknown;
  export default _;
}
