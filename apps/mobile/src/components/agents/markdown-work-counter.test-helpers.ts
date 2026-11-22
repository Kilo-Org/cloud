import { vi } from 'vitest';

/**
 * The characters a markdown scan reads, the characters it moves into new
 * strings, and the receiver length it pays a `String.prototype.at`,
 * `charCodeAt` or `codePointAt` for. A call count alone cannot tell the shapes
 * apart: a pass that re-reads the rest of the value per construct and a pass
 * that reads each construct once both make about one lookup per construct. What
 * separates them is how far each lookup travels, so:
 *
 * - `readUnits` adds the distance a `String.prototype.indexOf(search, from)`
 *   travels to its needle or to the end of the value on a miss, and the
 *   distance a sticky or global `RegExp.prototype.exec` scans from `lastIndex`
 *   to its match or the end. Retrying the search from the same spot is cheap
 *   when the value is nearly over and linear when it is not.
 * - `stringUnitsCopied` adds the length of every string `String.prototype.slice`
 *   returns, so a pass that rebuilds a tail per construct shows its copying even
 *   where the engine scans inside a native call.
 * - `arrayElementsCopied` adds the elements every `Array.prototype.slice` keeps,
 *   which is the same rebuild measured on the array side.
 * - `atReceiverUnits` adds the receiver length for every
 *   `String.prototype.at`, `charCodeAt` and `codePointAt`, because those reads
 *   cost their position in a large value rather than a fixed unit.
 *
 * `copiedUnits` is those three copying terms together: the fixtures that
 * convert compare it, since their conversion pass copies rather than searches,
 * and the fixture that gates images compares `readUnits`, since its copies are
 * zero on every revision and the rewrite's own search is what varies.
 */
export type MarkdownWork = { readonly readUnits: number; readonly copiedUnits: number };

// The natives, captured before the spies replace them. `Reflect.get` reads the
// function value without forming an unbound method reference.
const nativeIndexOf = Reflect.get(String.prototype, 'indexOf') as (
  this: string,
  search: string,
  from?: number
) => number;
const nativeSlice = Reflect.get(String.prototype, 'slice') as (
  this: string,
  start?: number,
  end?: number
) => string;
const nativeAt = Reflect.get(String.prototype, 'at') as (this: string, index: number) => string;
const nativeCharCodeAt = Reflect.get(String.prototype, 'charCodeAt') as (
  this: string,
  index: number
) => number;
const nativeCodePointAt = Reflect.get(String.prototype, 'codePointAt') as (
  this: string,
  index: number
) => number | undefined;
const nativeArraySlice = Reflect.get(Array.prototype, 'slice') as (
  this: readonly unknown[],
  start?: number,
  end?: number
) => readonly unknown[];
const nativeExec = Reflect.get(RegExp.prototype, 'exec') as (
  this: RegExp,
  value: string
) => RegExpExecArray | null;

/** Where an `Array.prototype.slice` start lands, counting a negative start from the end. */
function sliceStartIndex(length: number, start: number | undefined): number {
  if (start === undefined) {
    return 0;
  }
  const index = Number.isNaN(start) ? 0 : Math.trunc(start);
  return index < 0 ? Math.max(length + index, 0) : Math.min(index, length);
}

/** Runs `run` with every read and every copy above counted, then restores the natives. */
export function countMarkdownWork(run: () => void): MarkdownWork {
  let readUnits = 0;
  let stringUnitsCopied = 0;
  let arrayElementsCopied = 0;
  let atReceiverUnits = 0;

  const indexSpy = vi.spyOn(String.prototype, 'indexOf');
  indexSpy.mockImplementation(function countRead(this: string, search: string, from = 0): number {
    const found = nativeIndexOf.call(this, search, from);
    readUnits += found === -1 ? this.length - from : found - from + 1;
    return found;
  } as never);
  const execSpy = vi.spyOn(RegExp.prototype, 'exec');
  execSpy.mockImplementation(function countMatch(this: RegExp, value: string) {
    // Only a sticky or global pattern starts from `lastIndex`, so only those
    // read forward; the distance to the match, or to the end on a miss, is what
    // the engine scanned.
    const start = this.lastIndex;
    const match = nativeExec.call(this, value);
    if (this.sticky || this.global) {
      readUnits +=
        match === null ? Math.max(value.length - start, 0) : match.index - start + match[0].length;
    }
    return match;
  } as never);
  const stringSliceSpy = vi.spyOn(String.prototype, 'slice');
  stringSliceSpy.mockImplementation(function countStringSlice(
    this: string,
    start?: number,
    end?: number
  ): string {
    const sliced = nativeSlice.call(this, start, end);
    stringUnitsCopied += sliced.length;
    return sliced;
  } as never);
  const arraySliceSpy = vi.spyOn(Array.prototype, 'slice');
  arraySliceSpy.mockImplementation(function countArraySlice(
    this: readonly unknown[],
    start?: number,
    end?: number
  ): readonly unknown[] {
    arrayElementsCopied += Math.max(this.length - sliceStartIndex(this.length, start), 0);
    return nativeArraySlice.call(this, start, end);
  } as never);
  const atSpy = vi.spyOn(String.prototype, 'at');
  atSpy.mockImplementation(function countAt(this: string, index: number): string {
    atReceiverUnits += this.length;
    return nativeAt.call(this, index);
  } as never);
  const charCodeAtSpy = vi.spyOn(String.prototype, 'charCodeAt');
  charCodeAtSpy.mockImplementation(function countCharCodeAt(this: string, index: number): number {
    atReceiverUnits += this.length;
    return nativeCharCodeAt.call(this, index);
  } as never);
  const codePointAtSpy = vi.spyOn(String.prototype, 'codePointAt');
  codePointAtSpy.mockImplementation(function countCodePointAt(
    this: string,
    index: number
  ): number | undefined {
    atReceiverUnits += this.length;
    return nativeCodePointAt.call(this, index);
  } as never);

  try {
    run();
  } finally {
    indexSpy.mockRestore();
    execSpy.mockRestore();
    stringSliceSpy.mockRestore();
    arraySliceSpy.mockRestore();
    atSpy.mockRestore();
    charCodeAtSpy.mockRestore();
    codePointAtSpy.mockRestore();
  }
  return { readUnits, copiedUnits: stringUnitsCopied + arrayElementsCopied + atReceiverUnits };
}
