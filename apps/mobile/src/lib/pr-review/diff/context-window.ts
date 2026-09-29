// Pure window arithmetic for context expansion. A gap is loaded in
// `windowSize`-line slices; `alreadyLoaded` is the number of lines a
// previous slice already fetched, so the next slice starts right after
// them. The end is clamped by the gap's own `endLine` so the last slice
// never overshoots the gap.
//
// `startLine` is the first line the caller still needs. The diff loader
// keeps that invariant by moving `context.startLine` forward in
// `pushGapItems` (it is `gapStart + linesLoaded`) and then passing
// `alreadyLoaded: 0` here. A caller that instead passes the gap's
// original start with a non-zero `alreadyLoaded` must not also advance
// `startLine`, or the two offsets compose and skip a window (the defect
// this contract exists to prevent).

export type ContextWindow = {
  startLine: number;
  endLine: number;
};

export function buildContextWindow(args: {
  startLine: number;
  endLine: number;
  alreadyLoaded: number;
  windowSize: number;
}): ContextWindow {
  const nextStartLine = args.startLine + args.alreadyLoaded;
  const nextEndLine = Math.min(args.endLine, nextStartLine + args.windowSize - 1);
  return { startLine: nextStartLine, endLine: nextEndLine };
}
