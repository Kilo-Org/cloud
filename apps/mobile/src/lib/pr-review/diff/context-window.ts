// Pure window arithmetic for context expansion. A gap is loaded in
// `windowSize`-line slices; `alreadyLoaded` is the number of lines a
// previous slice already fetched, so the next slice starts right after
// them. The end is clamped by the gap's own `endLine` so the last slice
// never overshoots the gap.

export function buildContextWindow(args: {
  startLine: number;
  endLine: number;
  alreadyLoaded: number;
  windowSize: number;
}): { startLine: number; endLine: number } {
  const nextStartLine = args.startLine + args.alreadyLoaded;
  const nextEndLine = Math.min(args.endLine, nextStartLine + args.windowSize - 1);
  return { startLine: nextStartLine, endLine: nextEndLine };
}
