export type BackendUrlProblem = 'invalidUrl' | 'publicHttp' | 'httpApprovalRequired';

export class BackendUrlError extends Error {
  readonly problem: BackendUrlProblem;

  constructor(problem: BackendUrlProblem) {
    super(problem);
    this.problem = problem;
  }
}

export function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code !== undefined && (code < 32 || code === 127)) {
      return true;
    }
  }
  return false;
}

function parsedBackendUrl(input: string): URL {
  const trimmed = input.trim();
  if (hasControlCharacters(trimmed) || /\s/u.test(trimmed)) {
    throw new BackendUrlError('invalidUrl');
  }
  try {
    return new URL(trimmed);
  } catch {
    throw new BackendUrlError('invalidUrl');
  }
}

/** Literal private addresses only; a public DNS name is never assumed private. */
function isLocalBackendHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replaceAll(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    return true;
  }
  if (host === '::1' || /^(?:fc|fd)[\da-f]{2}:/.test(host) || /^fe[89ab][\da-f]:/.test(host)) {
    return true;
  }
  const parts = host.split('.');
  if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/.test(part))) {
    return false;
  }
  const bytes = parts.map(Number);
  if (bytes.some(byte => byte > 255)) {
    return false;
  }
  const [first, second] = bytes;
  return (
    first === 127 ||
    first === 10 ||
    (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

export function normalizeBackendUrl(input: string, allowLocalHttp: boolean): string {
  const url = parsedBackendUrl(input);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    input.includes('?') ||
    input.includes('#') ||
    !url.hostname ||
    !['https:', 'http:'].includes(url.protocol)
  ) {
    throw new BackendUrlError('invalidUrl');
  }
  if (url.protocol === 'http:') {
    if (!isLocalBackendHost(url.hostname)) {
      throw new BackendUrlError('publicHttp');
    }
    if (!allowLocalHttp) {
      throw new BackendUrlError('httpApprovalRequired');
    }
  }
  return url.href.replace(/\/+$/, '');
}
