export function getAnonymousUserId(ipAddress: string): string {
  return `anon:${ipAddress}`;
}

export function isAnonymousUserId(userId: string): boolean {
  return userId.startsWith('anon:');
}
