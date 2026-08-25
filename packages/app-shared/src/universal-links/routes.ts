/**
 * Single source of truth for Kilo web path → mobile app group-href mapping.
 * Consumed by AASA, assetlinks.json, Android intentFilters, and the runtime
 * URL translator — one table, four consumers.
 *
 * Pattern syntax: literal segments plus `*`, where `*` matches exactly ONE
 * path segment ([^/]+) and is captured for substitution into the target as
 * `<n>` (nth capture, 1-based). No regex.
 */

export type UniversalLinkRoute = {
  /** Web path pattern on app.kilo.ai (literal segments + `*`). */
  readonly webPath: string;
  /** Expo Router group href target; `<n>` = nth wildcard capture. */
  readonly appPath: string;
  /**
   * Segment values that must NOT match this row's wildcard position(s).
   * For multi-wildcard rows the exclusion applies to the final-segment
   * wildcard (the rightmost `*`).
   */
  readonly exclusions?: readonly string[];
};

export const UNIVERSAL_LINK_ROUTES: readonly UniversalLinkRoute[] = [
  { webPath: '/home', appPath: '/(app)/(tabs)/(0_home)' },
  { webPath: '/profile', appPath: '/(app)/(tabs)/(3_profile)' },
  { webPath: '/profile/preferences', appPath: '/(app)/(tabs)/(3_profile)/preferences' },
  { webPath: '/claw', appPath: '/(app)/(tabs)/(1_kiloclaw)' },
  { webPath: '/cloud/sessions', appPath: '/(app)/(tabs)/(2_agents)' },
  { webPath: '/cloud/sessions/*', appPath: '/(app)/agent-chat/<1>' },
  {
    webPath: '/security-agent',
    appPath: '/(app)/(tabs)/(3_profile)/security-agent/personal',
  },
  {
    webPath: '/security-agent/findings',
    appPath: '/(app)/(tabs)/(3_profile)/security-agent/personal/findings',
  },
  {
    webPath: '/code-reviews',
    appPath: '/(app)/(tabs)/(3_profile)/code-reviewer/personal',
  },
  {
    webPath: '/code-reviews/*',
    appPath: '/(app)/(tabs)/(3_profile)/code-reviewer/personal/reviews/<1>',
    exclusions: ['review-md'],
  },
  {
    webPath: '/organizations/*/security-agent',
    appPath: '/(app)/(tabs)/(3_profile)/security-agent/<1>',
  },
  {
    webPath: '/organizations/*/security-agent/findings',
    appPath: '/(app)/(tabs)/(3_profile)/security-agent/<1>/findings',
  },
  {
    webPath: '/organizations/*/code-reviews',
    appPath: '/(app)/(tabs)/(3_profile)/code-reviewer/<1>',
  },
  {
    webPath: '/organizations/*/code-reviews/*',
    appPath: '/(app)/(tabs)/(3_profile)/code-reviewer/<1>/reviews/<2>',
    exclusions: ['review-md'],
  },
  {
    webPath: '/organizations/*/overview',
    appPath: '/(app)/(tabs)/(3_profile)/organization/<1>',
  },
  {
    webPath: '/pr-review/*/*/*',
    appPath: '/(app)/pr-review/<1>/<2>/<3>',
  },
] as const;

const KILO_WEB_HOST = 'app.kilo.ai';

/**
 * Full URL → normalised web pathname. Host/scheme guard lives here only.
 * Returns `null` for anything that is not ours. Never throws.
 *
 * Prefer plain string parsing — Hermes does not guarantee full WHATWG URL.
 */
export function parseKiloWebPath(raw: string): string | null {
  if (typeof raw !== 'string' || raw.length === 0) {
    return null;
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const schemeEnd = trimmed.indexOf('://');
  if (schemeEnd <= 0) {
    return null;
  }

  const scheme = trimmed.slice(0, schemeEnd).toLowerCase();
  const afterScheme = trimmed.slice(schemeEnd + 3);

  // Drop query and fragment before path work.
  const withoutQuery = stripQueryAndFragment(afterScheme);

  if (scheme === 'https' || scheme === 'http') {
    return parseHttpsPath(withoutQuery);
  }

  if (scheme === 'kiloapp') {
    return parseKiloappPath(withoutQuery);
  }

  return null;
}

function stripQueryAndFragment(value: string): string {
  let end = value.length;
  const q = value.indexOf('?');
  const h = value.indexOf('#');
  if (q >= 0 && q < end) end = q;
  if (h >= 0 && h < end) end = h;
  return value.slice(0, end);
}

function parseHttpsPath(authorityAndPath: string): string | null {
  // authorityAndPath is "host[:port]/path..."
  if (authorityAndPath.length === 0) {
    return null;
  }

  const slash = authorityAndPath.indexOf('/');
  const authority = slash < 0 ? authorityAndPath : authorityAndPath.slice(0, slash);
  const pathPart = slash < 0 ? '' : authorityAndPath.slice(slash);

  // Strip optional port for host comparison.
  const colon = authority.indexOf(':');
  const host = (colon >= 0 ? authority.slice(0, colon) : authority).toLowerCase();

  if (host !== KILO_WEB_HOST) {
    return null;
  }

  return normalisePathname(pathPart.length === 0 ? '/' : pathPart);
}

/**
 * kiloapp:// forms (OS delivery varies):
 * - kiloapp:///profile          (empty host) → /profile
 * - kiloapp://profile           (host = first segment) → /profile
 * - kiloapp://app.kilo.ai/profile → /profile
 * - kiloapp://code-reviews/abc  (non-app host) → /code-reviews/abc
 */
function parseKiloappPath(authorityAndPath: string): string | null {
  // Empty everything: "kiloapp://" → authorityAndPath === ""
  if (authorityAndPath.length === 0) {
    return null;
  }

  // Triple-slash form leaves a leading "/" (empty host): "/profile" or "/"
  if (authorityAndPath.startsWith('/')) {
    return normalisePathname(authorityAndPath);
  }

  const slash = authorityAndPath.indexOf('/');
  const hostPart = slash < 0 ? authorityAndPath : authorityAndPath.slice(0, slash);
  const pathPart = slash < 0 ? '' : authorityAndPath.slice(slash);

  if (hostPart.length === 0) {
    return normalisePathname(pathPart.length === 0 ? '/' : pathPart);
  }

  // Host is app.kilo.ai (case-insensitive) → path alone is the pathname.
  if (hostPart.toLowerCase() === KILO_WEB_HOST) {
    return normalisePathname(pathPart.length === 0 ? '/' : pathPart);
  }

  // Non-empty host that is not app.kilo.ai: treat host + path as the path.
  const combined = `/${hostPart}${pathPart}`;
  return normalisePathname(combined);
}

/** Strip exactly one trailing `/` (except bare `/`). */
function normalisePathname(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith('/')) {
    return pathname.slice(0, -1);
  }
  return pathname;
}

/**
 * Pure table lookup on an already-normalised pathname.
 * `null` = unmapped or excluded.
 */
export function webPathToAppPath(webPath: string): string | null {
  for (const route of UNIVERSAL_LINK_ROUTES) {
    const captures = matchPattern(route.webPath, webPath);
    if (captures === null) {
      continue;
    }

    if (route.exclusions && route.exclusions.length > 0) {
      // Exclusion applies to the final-segment wildcard (rightmost capture).
      const finalCapture = captures[captures.length - 1];
      if (finalCapture !== undefined && route.exclusions.includes(finalCapture)) {
        return null;
      }
    }

    return substituteCaptures(route.appPath, captures);
  }

  return null;
}

/**
 * Match `pattern` against `path`. Both are absolute pathnames.
 * `*` matches exactly one non-empty segment. Returns captures or null.
 */
function matchPattern(pattern: string, path: string): string[] | null {
  const patternSegments = splitSegments(pattern);
  const pathSegments = splitSegments(path);

  if (patternSegments.length !== pathSegments.length) {
    return null;
  }

  const captures: string[] = [];

  for (const [i, pSeg] of patternSegments.entries()) {
    const pathSeg = pathSegments[i];
    if (pathSeg === undefined) {
      // Unreachable: segment counts are checked equal above.
      return null;
    }

    if (pSeg === '*') {
      // Single non-empty segment; empty segments never appear after split.
      if (pathSeg.length === 0) {
        return null;
      }
      captures.push(pathSeg);
      continue;
    }

    if (pSeg !== pathSeg) {
      return null;
    }
  }

  return captures;
}

function splitSegments(pathname: string): string[] {
  // "/a/b" → ["a","b"]; "/" → []; "" → []
  if (pathname === '/' || pathname === '') {
    return [];
  }
  const stripped = pathname.startsWith('/') ? pathname.slice(1) : pathname;
  // Do not collapse empty segments from double slashes — leave them so
  // "/profile//" (after one trailing-slash strip → "/profile/") fails to match.
  return stripped.split('/');
}

/**
 * Single pass over the template: already-inserted capture text is never
 * rescanned, so a captured segment — external input — always lands verbatim.
 * A per-capture `replaceAll` loop would both run ECMA-262 GetSubstitution on
 * `$` patterns in the capture and re-replace a literal `<n>` inserted by an
 * earlier pass.
 */
function substituteCaptures(appPath: string, captures: string[]): string {
  const parts: string[] = [];
  let cursor = 0;

  while (cursor < appPath.length) {
    const open = appPath.indexOf('<', cursor);
    if (open < 0) {
      break;
    }
    const close = appPath.indexOf('>', open);
    if (close < 0) {
      break;
    }

    const token = appPath.slice(open + 1, close);
    const n = Number.parseInt(token, 10);
    const capture = String(n) === token && n >= 1 ? captures[n - 1] : undefined;
    if (capture === undefined) {
      // Not a known placeholder — keep the text verbatim and move past it.
      parts.push(appPath.slice(cursor, close + 1));
      cursor = close + 1;
      continue;
    }

    parts.push(appPath.slice(cursor, open), capture);
    cursor = close + 1;
  }

  parts.push(appPath.slice(cursor));
  return parts.join('');
}

/** Single entry point: raw URL → Expo Router group href (or null). */
export function resolveIncomingUrl(raw: string): string | null {
  const webPath = parseKiloWebPath(raw);
  if (webPath === null) {
    return null;
  }
  return webPathToAppPath(webPath);
}

export type AasaComponent = {
  '/': string;
  exclude?: boolean;
};

/**
 * Compile the table to Apple AASA `components` entries.
 * Exclusion components are emitted immediately BEFORE their row.
 * Apple AASA `*` is a glob that crosses `/`; that superset is deliberate —
 * the table's `*` is kept verbatim in AASA output.
 */
export function aasaComponents(): AasaComponent[] {
  const components: AasaComponent[] = [];

  for (const route of UNIVERSAL_LINK_ROUTES) {
    if (route.exclusions) {
      for (const exclusion of route.exclusions) {
        components.push({
          '/': patternWithFinalWildcardReplaced(route.webPath, exclusion),
          exclude: true,
        });
      }
    }
    components.push({ '/': route.webPath });
  }

  return components;
}

/** Replace the rightmost `*` in a pattern with a concrete segment value. */
function patternWithFinalWildcardReplaced(pattern: string, value: string): string {
  const idx = pattern.lastIndexOf('*');
  if (idx < 0) {
    return pattern;
  }
  return pattern.slice(0, idx) + value + pattern.slice(idx + 1);
}

/**
 * Compile the table to Android `pathPattern` strings.
 * Each `*` segment becomes `.*`. Android cannot express exclusions — the
 * runtime matcher (`webPathToAppPath` / `resolveIncomingUrl`) is the
 * exclusion enforcement.
 */
export function androidPathPatterns(): string[] {
  return UNIVERSAL_LINK_ROUTES.map(route =>
    route.webPath
      .split('/')
      .map(seg => (seg === '*' ? '.*' : seg))
      .join('/')
  );
}
