import type { Env } from '../types';
import { verifyGitToken, type GitTokenPermission } from './jwt';

export type AuthResult = {
  isAuthenticated: boolean;
  errorResponse: Response | null;
};

export type JWTAuthResult =
  | { isAuthenticated: true; permission: GitTokenPermission }
  | { isAuthenticated: false; errorResponse: Response };

export type TokenVerifier = (token: string) => Promise<boolean>;

export function verifyBearerToken(request: Request, env: Env): AuthResult {
  const authHeader = request.headers.get('Authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return {
      isAuthenticated: false,
      errorResponse: new Response(
        JSON.stringify({
          success: false,
          error: 'authentication_required',
          message: 'Missing authorization token',
        }),
        {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }
      ),
    };
  }

  // Extract token by removing "Bearer " prefix
  const token = authHeader.slice(7);

  if (!env.AUTH_TOKEN || token !== env.AUTH_TOKEN) {
    return {
      isAuthenticated: false,
      errorResponse: new Response(
        JSON.stringify({
          success: false,
          error: 'invalid_token',
          message: 'Invalid authorization token',
        }),
        {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }
      ),
    };
  }

  // Authentication successful
  return {
    isAuthenticated: true,
    errorResponse: null,
  };
}

/**
 * Verify Git Basic authentication using JWT tokens
 * Expects username "x-access-token" and password as JWT token
 */
export async function verifyGitAuthJWT(
  request: Request,
  repoId: string,
  jwtSecret: string
): Promise<JWTAuthResult> {
  const authHeader = request.headers.get('Authorization');

  if (!authHeader || !authHeader.startsWith('Basic ')) {
    return {
      isAuthenticated: false,
      errorResponse: new Response('Unauthorized', {
        status: 401,
        headers: { 'WWW-Authenticate': 'Basic realm="Git"' },
      }),
    };
  }

  // Decode Base64 credentials
  const base64Credentials = authHeader.slice(6);
  let credentials: string;
  try {
    credentials = atob(base64Credentials);
  } catch {
    return {
      isAuthenticated: false,
      errorResponse: new Response('Invalid credentials format', {
        status: 401,
        headers: { 'WWW-Authenticate': 'Basic realm="Git"' },
      }),
    };
  }

  const [username, password] = credentials.split(':');

  // Verify username is x-access-token
  if (username !== 'x-access-token') {
    return {
      isAuthenticated: false,
      errorResponse: new Response('Invalid credentials', {
        status: 401,
        headers: { 'WWW-Authenticate': 'Basic realm="Git"' },
      }),
    };
  }

  // Verify JWT token
  const jwtResult = verifyGitToken(password, repoId, jwtSecret);
  if (jwtResult.valid === false) {
    return {
      isAuthenticated: false,
      errorResponse: new Response(`Unauthorized: ${jwtResult.error}`, {
        status: 401,
        headers: { 'WWW-Authenticate': 'Basic realm="Git"' },
      }),
    };
  }

  return {
    isAuthenticated: true,
    permission: jwtResult.permission,
  };
}

/**
 * Verify Git Basic authentication with hybrid support for JWT and legacy tokens
 * Tries JWT authentication first, then falls back to legacy token verification
 * Expects username "x-access-token" and password as either JWT or legacy token
 */
export async function verifyGitAuth(
  request: Request,
  repoId: string,
  jwtSecret: string,
  verifyLegacyToken: TokenVerifier
): Promise<JWTAuthResult> {
  const authHeader = request.headers.get('Authorization');

  if (!authHeader || !authHeader.startsWith('Basic ')) {
    return {
      isAuthenticated: false,
      errorResponse: new Response('Unauthorized', {
        status: 401,
        headers: { 'WWW-Authenticate': 'Basic realm="Git"' },
      }),
    };
  }

  // Decode Base64 credentials
  const base64Credentials = authHeader.slice(6);
  let credentials: string;
  try {
    credentials = atob(base64Credentials);
  } catch {
    return {
      isAuthenticated: false,
      errorResponse: new Response('Invalid credentials format', {
        status: 401,
        headers: { 'WWW-Authenticate': 'Basic realm="Git"' },
      }),
    };
  }

  const [username, password] = credentials.split(':');

  // Verify username is x-access-token
  if (username !== 'x-access-token') {
    return {
      isAuthenticated: false,
      errorResponse: new Response('Invalid credentials', {
        status: 401,
        headers: { 'WWW-Authenticate': 'Basic realm="Git"' },
      }),
    };
  }

  // Try JWT verification first (new method)
  const jwtResult = verifyGitToken(password, repoId, jwtSecret);
  if (jwtResult.valid === true) {
    return {
      isAuthenticated: true,
      permission: jwtResult.permission,
    };
  }

  // Fall back to legacy token verification
  const isValidLegacy = await verifyLegacyToken(password);
  if (isValidLegacy) {
    // Legacy tokens grant full access
    return {
      isAuthenticated: true,
      permission: 'full',
    };
  }

  // Both methods failed
  return {
    isAuthenticated: false,
    errorResponse: new Response('Unauthorized: Invalid token', {
      status: 401,
      headers: { 'WWW-Authenticate': 'Basic realm="Git"' },
    }),
  };
}
