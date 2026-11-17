/* eslint-disable */
// The subset of runtime globals this package's sources read. Every runtime
// that runs this package (Workers, Hermes, Node >= 18) provides each of these
// names, but none belongs to a JavaScript built-in library level, and the
// package's tsconfig keeps `lib` at the ES level only, so the exact shapes the
// code uses are declared here instead of pulling a whole platform library
// (`dom` or `WebWorker`) into a package that also ships to runtimes without
// it. Extend this file rather than widening `lib`.

/** Subset of the WHATWG `crypto` global used for session-id randomness. */
declare var crypto: { getRandomValues<T extends ArrayBufferView>(array: T): T };

declare var TextEncoder: new () => {
  readonly encoding: string;
  encode(input?: string): Uint8Array;
};

declare var TextDecoder: new (
  encoding?: string,
  options?: { fatal?: boolean; ignoreBOM?: boolean },
) => { readonly encoding: string; decode(input?: ArrayBuffer | ArrayBufferView): string };

declare var atob: (data: string) => string;

declare var btoa: (data: string) => string;

declare function structuredClone<T>(value: T): T;
