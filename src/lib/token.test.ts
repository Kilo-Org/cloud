import { getEnvVariable } from '@/lib/dotenvx';
import { describe, it, expect } from '@jest/globals';
import jwt from 'jsonwebtoken';
import type { User } from '@/db/schema';
import {
  generateApiToken,
  generateOrganizationApiToken,
  validateAuthorizationHeader,
  JWT_TOKEN_VERSION,
  type JWTTokenPayload,
} from './tokens';

// Test fixtures
const mockUser: User = {
  id: 'test-user-123',
  google_user_email: 'test@example.com',
  google_user_name: 'Test User',
  google_user_image_url: 'https://example.com/avatar.jpg',
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
  hosted_domain: null,
  microdollars_used: 0,
  kilo_pass_threshold: null,
  stripe_customer_id: 'cus_test123',
  is_admin: false,
  total_microdollars_acquired: 0,
  next_credit_expiration_at: null,
  has_validation_stytch: null,
  has_validation_novel_card_with_hold: false,
  blocked_reason: null,
  api_token_pepper: 'test-pepper-456',
  auto_top_up_enabled: false,
  default_model: null,
  is_bot: false,
  cohorts: {},
  completed_welcome_form: false,
  linkedin_url: null,
  github_url: null,
};

describe('Token Functions', () => {
  describe('generateApiToken', () => {
    it('should generate a valid JWT token for a user', () => {
      const token = generateApiToken(mockUser);

      expect(typeof token).toBe('string');
      expect(token.length).toBeGreaterThan(0);

      // Verify token can be decoded
      const decoded = jwt.decode(token) as jwt.JwtPayload & JWTTokenPayload;
      expect(decoded).toBeTruthy();
      expect(decoded.kiloUserId).toBe(mockUser.id);
      expect(decoded.apiTokenPepper).toBe(mockUser.api_token_pepper);
      expect(decoded.version).toBe(JWT_TOKEN_VERSION);
      expect(decoded.env).toBe(process.env.NODE_ENV);
      // Organization ID should never be in the token
      expect(decoded.organizationId).toBeUndefined();
    });

    it('should generate different tokens for different users', () => {
      const user2: User = {
        ...mockUser,
        id: 'different-user-456',
        api_token_pepper: 'different-pepper',
      };

      const token1 = generateApiToken(mockUser);
      const token2 = generateApiToken(user2);

      expect(token1).not.toBe(token2);
    });

    it('should include expiration time in token', () => {
      const token = generateApiToken(mockUser);
      const decoded = jwt.decode(token) as jwt.JwtPayload;

      expect(decoded.exp).toBeTruthy();
      expect(decoded.iat).toBeTruthy();
      // Token should expire in the future (more than 4 years from now)
      const fourYearsInSeconds = 4 * 365 * 24 * 60 * 60;
      const actualDuration = decoded.exp! - decoded.iat!;
      expect(actualDuration).toBeGreaterThan(fourYearsInSeconds);
    });
  });

  describe('validateAuthorizationHeader', () => {
    it('should validate a valid Bearer token successfully', () => {
      const token = generateApiToken(mockUser);
      const headers = new Headers();
      headers.set('authorization', `Bearer ${token}`);

      const result = validateAuthorizationHeader(headers);

      expect(result.error).toBeUndefined();
      expect(result.kiloUserId).toBe(mockUser.id);
      expect(result.apiTokenPepper).toBe(mockUser.api_token_pepper);
      // validateAuthorizationHeader should NOT return organizationId - that's handled at a higher level
    });

    it('should return error when authorization header is missing', () => {
      const headers = new Headers();

      const result = validateAuthorizationHeader(headers);

      expect(result.error).toBe('Unauthorized - authentication required');
      expect(result.kiloUserId).toBeUndefined();
    });

    it('should return error when authorization header does not start with Bearer', () => {
      const headers = new Headers();
      headers.set('authorization', 'Basic sometoken');

      const result = validateAuthorizationHeader(headers);

      expect(result.error).toBe('Unauthorized - authentication required');
      expect(result.kiloUserId).toBeUndefined();
    });

    it('should return error when authorization header is just "Bearer"', () => {
      const headers = new Headers();
      headers.set('authorization', 'Bearer');

      const result = validateAuthorizationHeader(headers);

      expect(result.error).toBe('Unauthorized - authentication required');
      expect(result.kiloUserId).toBeUndefined();
    });

    it('should return error when authorization header has Bearer with empty token', () => {
      const headers = new Headers();
      headers.set('authorization', 'Bearer ');

      const result = validateAuthorizationHeader(headers);

      expect(result.error).toBe('Unauthorized - authentication required');
      expect(result.kiloUserId).toBeUndefined();
    });

    it('should return error for invalid JWT token', () => {
      const headers = new Headers();
      headers.set('authorization', 'Bearer invalid.jwt.token');

      const result = validateAuthorizationHeader(headers);

      expect(result.error).toMatch(/^Invalid token( \([a-f0-9-]+\))?$/);
      expect(result.kiloUserId).toBeUndefined();
    });

    it('should return error for JWT token with wrong signature', () => {
      // Create a token with a different secret
      const wrongToken = jwt.sign(
        {
          env: process.env.NODE_ENV,
          kiloUserId: mockUser.id,
          apiTokenPepper: mockUser.api_token_pepper,
          version: JWT_TOKEN_VERSION,
        },
        'wrong-secret',
        { algorithm: 'HS256', expiresIn: '5y' }
      );

      const headers = new Headers();
      headers.set('authorization', `Bearer ${wrongToken}`);

      const result = validateAuthorizationHeader(headers);

      expect(result.error).toMatch(/^Invalid token( \([a-f0-9-]+\))?$/);
      expect(result.kiloUserId).toBeUndefined();
    });

    it('should return error for token with outdated version', () => {
      const outdatedToken = jwt.sign(
        {
          env: process.env.NODE_ENV,
          kiloUserId: mockUser.id,
          apiTokenPepper: mockUser.api_token_pepper,
          version: JWT_TOKEN_VERSION - 1, // Outdated version
        },
        getEnvVariable('NEXTAUTH_SECRET'),
        { algorithm: 'HS256', expiresIn: '5y' }
      );

      const headers = new Headers();
      headers.set('authorization', `Bearer ${outdatedToken}`);

      const result = validateAuthorizationHeader(headers);

      expect(result.error).toMatch(
        /^Token version outdated, please re-authenticate( \([a-f0-9-]+\))?$/
      );
      expect(result.kiloUserId).toBeUndefined();
    });

    it('should return error for expired token', () => {
      const expiredToken = jwt.sign(
        {
          env: process.env.NODE_ENV,
          kiloUserId: mockUser.id,
          apiTokenPepper: mockUser.api_token_pepper,
          version: JWT_TOKEN_VERSION,
        },
        getEnvVariable('NEXTAUTH_SECRET'),
        { algorithm: 'HS256', expiresIn: '-1h' } // Expired 1 hour ago
      );

      const headers = new Headers();
      headers.set('authorization', `Bearer ${expiredToken}`);

      const result = validateAuthorizationHeader(headers);

      expect(result.error).toMatch(/^Invalid token( \([a-f0-9-]+\))?$/);
      expect(result.kiloUserId).toBeUndefined();
    });

    it('should handle case-insensitive Bearer prefix', () => {
      const token = generateApiToken(mockUser);
      const headers = new Headers();
      headers.set('authorization', `bearer ${token}`); // lowercase

      const result = validateAuthorizationHeader(headers);

      expect(result.error).toBeUndefined();
      expect(result.kiloUserId).toBe(mockUser.id);
    });

    it('should handle mixed case Bearer prefix', () => {
      const token = generateApiToken(mockUser);
      const headers = new Headers();
      headers.set('authorization', `BeArEr ${token}`); // mixed case

      const result = validateAuthorizationHeader(headers);

      expect(result.error).toBeUndefined();
      expect(result.kiloUserId).toBe(mockUser.id);
    });

    describe('generateOrganizationApiToken', () => {
      const organizationId = 'org-123-456';
      const organizationRole = 'member' as const;

      it('should generate a valid JWT token with organization ID and role', () => {
        const result = generateOrganizationApiToken(mockUser, organizationId, organizationRole);

        expect(typeof result.token).toBe('string');
        expect(result.token.length).toBeGreaterThan(0);
        expect(typeof result.expiresAt).toBe('string');

        // Verify expiresAt is a valid ISO date string
        const expiresAtDate = new Date(result.expiresAt);
        expect(expiresAtDate.toISOString()).toBe(result.expiresAt);

        // Verify expiresAt is approximately 15 minutes in the future
        const now = Date.now();
        const expiresAtMs = expiresAtDate.getTime();
        const diffMs = expiresAtMs - now;
        expect(diffMs).toBeGreaterThan(14 * 60 * 1000); // At least 14 minutes
        expect(diffMs).toBeLessThan(16 * 60 * 1000); // At most 16 minutes

        // Verify token can be decoded
        const decoded = jwt.decode(result.token) as jwt.JwtPayload & JWTTokenPayload;
        expect(decoded).toBeTruthy();
        expect(decoded.kiloUserId).toBe(mockUser.id);
        expect(decoded.apiTokenPepper).toBe(mockUser.api_token_pepper);
        expect(decoded.version).toBe(JWT_TOKEN_VERSION);
        expect(decoded.env).toBe(process.env.NODE_ENV);
        expect(decoded.organizationId).toBe(organizationId);
        expect(decoded.organizationRole).toBe(organizationRole);
      });

      it('should generate tokens with 15 minute expiration', () => {
        const result = generateOrganizationApiToken(mockUser, organizationId, organizationRole);
        const decoded = jwt.decode(result.token) as jwt.JwtPayload;

        expect(decoded.exp).toBeTruthy();
        expect(decoded.iat).toBeTruthy();

        // Token should expire in approximately 15 minutes (900 seconds)
        const actualDuration = decoded.exp! - decoded.iat!;
        expect(actualDuration).toBe(900);
      });

      it('should generate different tokens for different organizations', () => {
        const result1 = generateOrganizationApiToken(mockUser, 'org-1', 'owner');
        const result2 = generateOrganizationApiToken(mockUser, 'org-2', 'member');

        expect(result1.token).not.toBe(result2.token);

        const decoded1 = jwt.decode(result1.token) as jwt.JwtPayload & JWTTokenPayload;
        const decoded2 = jwt.decode(result2.token) as jwt.JwtPayload & JWTTokenPayload;

        expect(decoded1.organizationId).toBe('org-1');
        expect(decoded1.organizationRole).toBe('owner');
        expect(decoded2.organizationId).toBe('org-2');
        expect(decoded2.organizationRole).toBe('member');
      });

      it('should be validated successfully by validateAuthorizationHeader', () => {
        const { token } = generateOrganizationApiToken(mockUser, organizationId, organizationRole);
        const headers = new Headers();
        headers.set('authorization', `Bearer ${token}`);

        const result = validateAuthorizationHeader(headers);

        expect(result.error).toBeUndefined();
        expect(result.kiloUserId).toBe(mockUser.id);
        expect(result.apiTokenPepper).toBe(mockUser.api_token_pepper);
        expect(result.organizationId).toBe(organizationId);
        expect(result.organizationRole).toBe(organizationRole);
      });

      it('should expire after 15 minutes', () => {
        // Create a token that expired 1 minute ago
        const expiredToken = jwt.sign(
          {
            env: process.env.NODE_ENV,
            kiloUserId: mockUser.id,
            apiTokenPepper: mockUser.api_token_pepper,
            version: JWT_TOKEN_VERSION,
            organizationId,
          },
          getEnvVariable('NEXTAUTH_SECRET'),
          { algorithm: 'HS256', expiresIn: '-1m' }
        );

        const headers = new Headers();
        headers.set('authorization', `Bearer ${expiredToken}`);

        const result = validateAuthorizationHeader(headers);

        expect(result.error).toMatch(/^Invalid token( \([a-f0-9-]+\))?$/);
        expect(result.kiloUserId).toBeUndefined();
      });
    });
  });

  describe('Token payload structure', () => {
    it('should create tokens with correct algorithm', () => {
      const token = generateApiToken(mockUser);
      const header = jwt.decode(token, { complete: true })?.header;

      expect(header?.alg).toBe('HS256');
    });

    it('should include all required fields in user token payload', () => {
      const token = generateApiToken(mockUser);
      const payload = jwt.decode(token) as jwt.JwtPayload & JWTTokenPayload;

      expect(payload.env).toBe(process.env.NODE_ENV);
      expect(payload.kiloUserId).toBe(mockUser.id);
      expect(payload.apiTokenPepper).toBe(mockUser.api_token_pepper);
      expect(payload.version).toBe(JWT_TOKEN_VERSION);
      expect(payload.iat).toBeTruthy();
      expect(payload.exp).toBeTruthy();
      // Organization ID should never be in token payload
      expect(payload.organizationId).toBeUndefined();
    });
  });
});
