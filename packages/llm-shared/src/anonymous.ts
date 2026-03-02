export function getAnonymousUserId(ipAddress: string): string {
  return `anon:${ipAddress}`;
}

export function isAnonymousUserId(userId: string): boolean {
  return userId.startsWith('anon:');
}

export type AnonymousUserContext = {
  isAnonymous: true;
  ipAddress: string;
  id: string;
  microdollars_used: number;
  is_admin: false;
};

export function createAnonymousContext(ipAddress: string): AnonymousUserContext {
  return {
    isAnonymous: true,
    ipAddress,
    id: getAnonymousUserId(ipAddress),
    microdollars_used: 0,
    is_admin: false,
  };
}

export function isAnonymousContext(user: unknown): user is AnonymousUserContext {
  return (
    typeof user === 'object' && user !== null && 'isAnonymous' in user && user.isAnonymous === true
  );
}
