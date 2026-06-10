const RETURN_PATH_RE = /^\/(?![/\\])[^\r\n]*$/;

export function validateReturnPath(candidate: string): string | null {
  if (!RETURN_PATH_RE.test(candidate) || candidate.startsWith('//')) {
    return null;
  }
  return candidate;
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
