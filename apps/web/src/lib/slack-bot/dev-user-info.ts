import os from 'os';

/**
 * Check if the app is running in a nodenv dev environment
 */
export function isDevEnvironment(): boolean {
  return process.env.NODE_ENV === 'development';
}

/**
 * Get the local Linux username
 */
export function getLocalUsername(): string {
  try {
    return os.userInfo().username;
  } catch (error) {
    console.error('[DevUserInfo] Failed to get username:', error);
    return 'unknown';
  }
}

/**
 * Get a dev user suffix to append to messages if in dev environment
 * Returns empty string if not in dev, or formatted username if in dev
 */
export function getDevUserSuffix(): string {
  if (!isDevEnvironment()) {
    return '';
  }

  const username = getLocalUsername();
  return `\n\n_[Dev: ${username}]_`;
}
