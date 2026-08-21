export const MOBILE_OPEN_ROUTES = [
  { name: 'home', path: '/home', description: 'Home tab' },
  { name: 'sessions', path: '/cloud/sessions', description: 'Session list (Agents tab)' },
  { name: 'session-list', path: '/cloud/sessions', description: 'Alias of sessions' },
  {
    name: 'session',
    path: '/cloud/sessions/<session-id>',
    description: 'One session. Pass --session-id=<id>.',
  },
  { name: 'settings', path: '/profile/preferences', description: 'Settings / preferences' },
  { name: 'profile', path: '/profile', description: 'Profile tab' },
] as const;

const NAMED_PATHS: Record<string, string> = {
  home: '/home',
  sessions: '/cloud/sessions',
  'session-list': '/cloud/sessions',
  settings: '/profile/preferences',
  profile: '/profile',
};

export type MobileOpenPlatform = 'ios' | 'android';

export type MobileOpenOptions = {
  email: string;
  route: string;
  sessionId: string | null;
  platform: MobileOpenPlatform | null;
  udid: string | null;
  serial: string | null;
};

export function printMobileOpenUsage(): void {
  console.log('Usage: pnpm dev:mobile:open --email <seeded-email> <route> [options]');
  console.log('');
  console.log('Issues a device session for a seeded user and opens the mobile dev build');
  console.log('on that route. Dev-build only: the app reads session tokens from the URL');
  console.log('when __DEV__ is true.');
  console.log('');
  console.log('Routes:');
  for (const route of MOBILE_OPEN_ROUTES) {
    console.log(`  ${route.name.padEnd(14)} ${route.path.padEnd(32)} ${route.description}`);
  }
  console.log('  /<path>         raw web path already in the universal-link table');
  console.log('');
  console.log('Options:');
  console.log('  --email=<email>         Seeded user email (required)');
  console.log('  --session-id=<id>       Required when <route> is session');
  console.log('  --ios                   Open on the booted iOS simulator');
  console.log('  --android               Open on a connected Android device/emulator');
  console.log('  --udid=<udid>           iOS simulator UDID (default: booted)');
  console.log('  --serial=<serial>       Android serial (default: first adb device)');
  console.log('');
  console.log('Examples:');
  console.log('  pnpm dev:mobile:open');
  console.log('  pnpm dev:mobile:open --email ada@example.com home');
  console.log('  pnpm dev:mobile:open --email ada@example.com session --session-id ses_1 --ios');
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function takeFlagValue(
  args: string[],
  index: number,
  flag: string
): { value: string; consumed: number } {
  const arg = args[index];
  if (arg.length > flag.length && arg[flag.length] === '=') {
    const inline = arg.slice(flag.length + 1).trim();
    if (!inline) {
      throw new Error(`${flag} requires a value`);
    }
    return { value: inline, consumed: 1 };
  }
  const next = args[index + 1];
  if (next === undefined || next.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return { value: next.trim(), consumed: 2 };
}

export function parseMobileOpenArgs(args: string[]): MobileOpenOptions | null {
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    return null;
  }

  let email: string | null = null;
  let route: string | null = null;
  let sessionId: string | null = null;
  let platform: MobileOpenPlatform | null = null;
  let udid: string | null = null;
  let serial: string | null = null;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--ios') {
      platform = 'ios';
      continue;
    }
    if (arg === '--android') {
      platform = 'android';
      continue;
    }
    if (arg === '--email' || arg.startsWith('--email=')) {
      const taken = takeFlagValue(args, index, '--email');
      email = taken.value;
      index += taken.consumed - 1;
      continue;
    }
    if (arg === '--session-id' || arg.startsWith('--session-id=')) {
      const taken = takeFlagValue(args, index, '--session-id');
      sessionId = taken.value;
      index += taken.consumed - 1;
      continue;
    }
    if (arg === '--udid' || arg.startsWith('--udid=')) {
      const taken = takeFlagValue(args, index, '--udid');
      udid = taken.value;
      index += taken.consumed - 1;
      continue;
    }
    if (arg === '--serial' || arg.startsWith('--serial=')) {
      const taken = takeFlagValue(args, index, '--serial');
      serial = taken.value;
      index += taken.consumed - 1;
      continue;
    }
    if (arg.startsWith('--')) {
      throw new Error(`Unknown argument: ${arg}`);
    }
    if (route !== null) {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }
    route = arg.trim();
  }

  if (!email) {
    throw new Error('--email is required');
  }
  if (!isValidEmail(email)) {
    throw new Error(`email is not a valid address: ${email}`);
  }
  if (!route) {
    throw new Error('route is required');
  }

  return { email, route, sessionId, platform, udid, serial };
}

export function resolveMobileOpenRoute(route: string, sessionId: string | null): string {
  if (route === 'session') {
    if (!sessionId) {
      throw new Error('session requires --session-id=<id>');
    }
    if (sessionId.includes('/') || sessionId.includes('?')) {
      throw new Error('--session-id must be a single path segment');
    }
    return `/cloud/sessions/${sessionId}`;
  }
  if (route.startsWith('/')) {
    return route;
  }
  const named = NAMED_PATHS[route];
  if (!named) {
    const names = MOBILE_OPEN_ROUTES.map(entry => entry.name).join(', ');
    throw new Error(`Unknown route: ${route}. Known routes: ${names}`);
  }
  return named;
}

export function buildDevSessionUrl(
  pathName: string,
  credentials: {
    token: string;
    refreshToken: string;
    expiresIn: number;
  }
): string {
  const params = new URLSearchParams({
    dev_session_token: credentials.token,
    dev_session_refresh: credentials.refreshToken,
    dev_session_expires_in: String(credentials.expiresIn),
  });
  return `kiloapp://${pathName}?${params.toString()}`;
}
