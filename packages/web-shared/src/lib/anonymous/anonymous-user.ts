import { getAnonymousUserId } from './ip-rate-limiter';

export type AnonymousUserContext = {
  isAnonymous: true;
  ipAddress: string;
  // Synthetic user-like properties for compatibility with existing code
  id: string; // Format: 'anon:{ip_address}'
  microdollars_used: number;
  is_admin: false;
};

export function createAnonymousContext(ipAddress: string): AnonymousUserContext {
  return {
    isAnonymous: true,
    ipAddress,
    id: getAnonymousUserId(ipAddress), // 'anon:{ip_address}'
    microdollars_used: 0,
    is_admin: false,
  };
}

export function isAnonymousContext(user: unknown): user is AnonymousUserContext {
  return (
    typeof user === 'object' && user !== null && 'isAnonymous' in user && user.isAnonymous === true
  );
}
