import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';

import { device_refresh_tokens, device_sessions, kilocode_users } from '@kilocode/db/schema';
import { signKiloToken } from '@kilocode/worker-utils';
import { eq } from 'drizzle-orm';

import { resolveAndroidEnvironment } from './mobile-android';
import {
  buildDevSessionUrl,
  parseMobileOpenArgs,
  printMobileOpenUsage,
  resolveMobileOpenRoute,
} from './mobile-open-routes';
import { getSeedDb } from '../seed/lib/db';
import { resolveSeedUserId } from '../seed/lib/users';

const ACCESS_TOKEN_SECONDS = 60 * 60;
const REFRESH_TOKEN_SECONDS = 30 * 24 * 60 * 60;
const DEV_USER_AGENT = 'kilo-dev-mobile-open';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

async function issueDevMobileSession(userId: string): Promise<{
  token: string;
  refreshToken: string;
  expiresIn: number;
}> {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) {
    throw new Error(
      'NEXTAUTH_SECRET is not set for this worktree. Run pnpm dev:worktree:prepare first.'
    );
  }

  const db = getSeedDb();
  const [user] = await db
    .select({
      id: kilocode_users.id,
      apiTokenPepper: kilocode_users.api_token_pepper,
    })
    .from(kilocode_users)
    .where(eq(kilocode_users.id, userId))
    .limit(1);
  if (!user) {
    throw new Error(`User ${userId} was not found`);
  }

  const [session] = await db
    .insert(device_sessions)
    .values({
      kilo_user_id: user.id,
      user_agent: DEV_USER_AGENT,
    })
    .returning({ id: device_sessions.id });
  if (!session) {
    throw new Error('Failed to create device session');
  }

  const { token } = await signKiloToken({
    userId: user.id,
    pepper: user.apiTokenPepper,
    secret,
    expiresInSeconds: ACCESS_TOKEN_SECONDS,
    env: process.env.NODE_ENV ?? 'development',
    extra: { deviceSessionId: session.id },
  });
  const refreshToken = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_SECONDS * 1000).toISOString();
  await db.insert(device_refresh_tokens).values({
    token_hash: hashToken(refreshToken),
    device_session_id: session.id,
    expires_at: expiresAt,
  });

  return {
    token,
    refreshToken,
    expiresIn: ACCESS_TOKEN_SECONDS,
  };
}

function detectIosBooted(): boolean {
  try {
    const output = execFileSync('xcrun', ['simctl', 'list', 'devices', 'booted'], {
      encoding: 'utf8',
    });
    return output.includes('(Booted)');
  } catch {
    return false;
  }
}

function firstAndroidSerial(): string | null {
  try {
    const env = resolveAndroidEnvironment({
      home: process.env.HOME ?? '',
      path: process.env.PATH ?? '',
    });
    const output = execFileSync(env.adb, ['devices'], { encoding: 'utf8' });
    const lines = output.split('\n').slice(1);
    for (const line of lines) {
      const [serial, state] = line.trim().split(/\s+/);
      if (serial && state === 'device') {
        return serial;
      }
    }
    return null;
  } catch {
    return null;
  }
}

function openOnIos(url: string, udid: string | null): void {
  const target = udid ?? 'booted';
  execFileSync('xcrun', ['simctl', 'openurl', target, url], { stdio: 'inherit' });
}

function openOnAndroid(url: string, serial: string | null): void {
  const env = resolveAndroidEnvironment({
    home: process.env.HOME ?? '',
    path: process.env.PATH ?? '',
  });
  const args = ['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', url];
  if (serial) {
    execFileSync(env.adb, ['-s', serial, ...args], { stdio: 'inherit' });
    return;
  }
  execFileSync(env.adb, args, { stdio: 'inherit' });
}

export async function runMobileOpen(args: string[]): Promise<void> {
  const options = parseMobileOpenArgs(args);
  if (!options) {
    printMobileOpenUsage();
    return;
  }

  const webPath = resolveMobileOpenRoute(options.route, options.sessionId);
  const userId = await resolveSeedUserId(options.email);
  const credentials = await issueDevMobileSession(userId);
  const url = buildDevSessionUrl(webPath, credentials);

  let platform = options.platform;
  if (!platform) {
    if (detectIosBooted()) {
      platform = 'ios';
    } else if (firstAndroidSerial()) {
      platform = 'android';
    } else {
      throw new Error(
        'No booted iOS simulator or connected Android device. Boot one, or pass --ios / --android.'
      );
    }
  }

  if (platform === 'ios') {
    openOnIos(url, options.udid);
  } else {
    openOnAndroid(url, options.serial);
  }

  console.log(`Opened ${webPath} as ${options.email} (${userId}) on ${platform}`);
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (isMain) {
  runMobileOpen(process.argv.slice(2)).catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
