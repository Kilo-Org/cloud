const RETURN_PATH_BASE = 'https://return-path.invalid';

function containsUnsafeReturnPathCharacter(candidate: string): boolean {
  return [...candidate].some(character => {
    const codePoint = character.charCodeAt(0);
    return character === '\\' || codePoint <= 0x1f || codePoint === 0x7f;
  });
}

export function validateReturnPath(candidate: string): string | null {
  if (!candidate.startsWith('/') || containsUnsafeReturnPathCharacter(candidate)) return null;

  try {
    const resolved = new URL(candidate, RETURN_PATH_BASE);
    const normalizedPath = `${resolved.pathname}${resolved.search}${resolved.hash}`;
    if (resolved.origin !== RETURN_PATH_BASE || normalizedPath.startsWith('//')) return null;
    return normalizedPath;
  } catch {
    return null;
  }
}

export function parseStateReturn(rawState: string | null): {
  ownerToken: string;
  returnTo: string | null;
} {
  let ownerToken = rawState ?? '';
  let returnTo: string | null = null;

  if (rawState) {
    const sepIdx = rawState.indexOf('|return=');
    if (sepIdx !== -1) {
      ownerToken = rawState.slice(0, sepIdx);
      try {
        const candidate = decodeURIComponent(rawState.slice(sepIdx + '|return='.length));
        returnTo = validateReturnPath(candidate);
      } catch {
        returnTo = null;
      }
    }
  }

  return { ownerToken, returnTo };
}
