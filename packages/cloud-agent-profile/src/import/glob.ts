/**
 * A glob compiles once into a token list that is reused across paths. Each
 * match tracks the set of positions the pattern has reached so far and advances
 * it once per token.
 */

const SLASH = 0x2f;

/** `*` stays inside one segment, `**` spans separators, double-star-plus-slash spans whole segments. */
type StarKind = 'segment-star' | 'segments-star' | 'any-star';

type GlobToken =
  | { kind: 'literal'; value: string; failure: Int32Array }
  | { kind: 'any' }
  | { kind: StarKind };

function isStar(token: GlobToken): token is { kind: StarKind } {
  return (
    token.kind === 'segment-star' || token.kind === 'segments-star' || token.kind === 'any-star'
  );
}

/** Prefix function (Knuth-Morris-Pratt) so a literal run is located in one path pass. */
function kmpFailure(value: string): Int32Array {
  const failure = new Int32Array(value.length);
  let matched = 0;
  for (let index = 1; index < value.length; index += 1) {
    while (matched > 0 && value[index] !== value[matched]) matched = failure[matched - 1];
    if (value[index] === value[matched]) matched += 1;
    failure[index] = matched;
  }
  return failure;
}

/**
 * Translate a `kilo.json` instruction glob into tokens: `**` spans path
 * separators, `*` and `?` stay inside one segment.
 */
function tokenize(pattern: string): GlobToken[] {
  const normalized = pattern.replaceAll('\\', '/').replace(/^\.\//, '');
  const tokens: GlobToken[] = [];
  let literal = '';
  let index = 0;

  const flushLiteral = (): void => {
    if (literal.length === 0) return;
    tokens.push({ kind: 'literal', value: literal, failure: kmpFailure(literal) });
    literal = '';
  };

  const pushStar = (kind: StarKind): void => {
    const previous = tokens[tokens.length - 1];
    // Consecutive stars collapse when one language contains the other: equal
    // kinds, or either side being `any-star` (`.*`), which contains both
    // narrower stars. `*` never merges with `**/` in either order, since `abc`
    // matches the first only.
    if (
      previous !== undefined &&
      isStar(previous) &&
      (previous.kind === kind || previous.kind === 'any-star' || kind === 'any-star')
    ) {
      tokens[tokens.length - 1] = {
        kind: previous.kind === 'any-star' || kind === 'any-star' ? 'any-star' : kind,
      };
      return;
    }
    tokens.push({ kind });
  };

  while (index < normalized.length) {
    const char = normalized[index];
    if (char === '*') {
      flushLiteral();
      if (normalized[index + 1] === '*') {
        if (normalized[index + 2] === '/') {
          pushStar('segments-star');
          index += 3;
        } else {
          pushStar('any-star');
          index += 2;
        }
      } else {
        pushStar('segment-star');
        index += 1;
      }
      continue;
    }
    if (char === '?') {
      flushLiteral();
      tokens.push({ kind: 'any' });
      index += 1;
      continue;
    }
    literal += char;
    index += 1;
  }
  flushLiteral();

  return tokens;
}

export type CompiledGlob = {
  /** True when the whole path matches the glob. */
  matches: (path: string) => boolean;
  /** Token count of the pattern; the import multiplies it by candidate path bytes. */
  tokenCount: number;
};

/**
 * Compile a glob into a reusable matcher. The matcher keeps its position-set
 * buffers between calls, so matching allocates nothing once warm.
 */
export function compileGlob(pattern: string): CompiledGlob {
  const tokens = tokenize(pattern);

  let currentFlags = new Uint8Array(0);
  let currentList = new Int32Array(0);
  let nextFlags = new Uint8Array(0);
  let nextList = new Int32Array(0);
  let currentCount = 0;
  let nextCount = 0;

  // Each set is described by its own index list, so clearing is proportional
  // to the set size, and the flag doubles as the dedupe check (`**/` both
  // copies the current set and extends it).
  const pushNext = (position: number): void => {
    if (nextFlags[position] !== 0) return;
    nextFlags[position] = 1;
    nextList[nextCount] = position;
    nextCount += 1;
  };

  const matches = (path: string): boolean => {
    const size = path.length + 1;
    if (currentFlags.length < size) {
      const capacity = Math.max(size, 64);
      currentFlags = new Uint8Array(capacity);
      currentList = new Int32Array(capacity);
      nextFlags = new Uint8Array(capacity);
      nextList = new Int32Array(capacity);
      currentCount = 0;
      nextCount = 0;
    }

    // The scratch set starts empty; the previous call's final set does not.
    for (let index = 0; index < currentCount; index += 1) currentFlags[currentList[index]] = 0;
    currentFlags[0] = 1;
    currentList[0] = 0;
    currentCount = 1;
    nextCount = 0;

    for (const token of tokens) {
      if (token.kind === 'literal') {
        const run = token.value;
        const runLength = run.length;
        const failure = token.failure;
        let matched = 0;
        for (let position = 0; position < path.length; position += 1) {
          const char = path.charCodeAt(position);
          while (matched > 0 && char !== run.charCodeAt(matched)) matched = failure[matched - 1];
          if (char === run.charCodeAt(matched)) matched += 1;
          if (matched < runLength) continue;
          const start = position - runLength + 1;
          if (currentFlags[start] !== 0) pushNext(start + runLength);
          matched = failure[runLength - 1];
        }
      } else if (token.kind === 'any') {
        for (let index = 0; index < currentCount; index += 1) {
          const at = currentList[index];
          if (at < path.length && path.charCodeAt(at) !== SLASH) pushNext(at + 1);
        }
      } else if (token.kind === 'any-star') {
        let open = false;
        for (let position = 0; position <= path.length; position += 1) {
          if (currentFlags[position] !== 0) open = true;
          if (open) pushNext(position);
        }
      } else if (token.kind === 'segment-star') {
        let open = false;
        for (let position = 0; position <= path.length; position += 1) {
          if (currentFlags[position] !== 0) open = true;
          if (!open) continue;
          pushNext(position);
          if (position < path.length && path.charCodeAt(position) === SLASH) open = false;
        }
      } else {
        // `**/` is empty or anything ending in `/`: every reachable position
        // stays reachable, and so does every position after a `/`.
        for (let position = 0; position <= path.length; position += 1) {
          if (
            currentFlags[position] !== 0 ||
            (position > 0 && path.charCodeAt(position - 1) === SLASH)
          ) {
            pushNext(position);
          }
        }
      }

      if (nextCount === 0) return false;

      // Swap the sets, clearing the one that becomes the scratch.
      for (let index = 0; index < currentCount; index += 1) currentFlags[currentList[index]] = 0;
      const staleFlags = currentFlags;
      const staleList = currentList;
      currentFlags = nextFlags;
      currentList = nextList;
      currentCount = nextCount;
      nextFlags = staleFlags;
      nextList = staleList;
      nextCount = 0;
    }

    return currentFlags[path.length] !== 0;
  };

  return { matches, tokenCount: tokens.length };
}
