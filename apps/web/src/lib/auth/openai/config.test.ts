import { describe, expect, jest, test } from '@jest/globals';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import {
  OPENAI_DISCOVERY_URL,
  OPENAI_IDENTITY_SCOPE,
  OPENAI_ISSUER,
  OPENAI_REDIRECT_PATH,
  OPENAI_REDIRECT_URI,
  OPENAI_RESOURCE,
  OPENAI_TOKEN_ENDPOINT,
  OPENAI_TOKEN_SHARING_SCOPE,
  isOpenAiTokenSharingGrant,
} from './config';

// The registered OpenAI client id, assembled from two fragments so that this
// test file does not itself contain the literal it forbids — the source scan
// below covers every TypeScript file in this directory, including this one.
const FORBIDDEN_CLIENT_ID_LITERAL = ['oaiapp', 'Abz1xcqSQAvvIwtxyemZbXBJ'].join('_');

const openAiDir = __dirname;
const scannerFiles = [
  ...readdirSync(openAiDir)
    .filter(file => file.endsWith('.ts'))
    .map(file => path.join(openAiDir, file)),
  path.resolve(openAiDir, '../../user/server.ts'),
  path.resolve(openAiDir, '../../config.server.ts'),
];

describe('OpenAI OAuth config', () => {
  test('uses the registered callback path and derives the redirect URI from the app origin', () => {
    expect(OPENAI_REDIRECT_PATH).toBe('/auth/openai/callback');
    expect(OPENAI_REDIRECT_URI.endsWith(OPENAI_REDIRECT_PATH)).toBe(true);
  });

  test('keeps endpoints discovery-driven and pinned to the OpenAI issuer', () => {
    expect(OPENAI_ISSUER).toBe('https://auth.openai.com');
    expect(OPENAI_DISCOVERY_URL).toMatch(
      /^https:\/\/auth\.openai\.com\/\.well-known\/openid-configuration$/
    );
    expect(OPENAI_TOKEN_ENDPOINT).toMatch(/\/oauth\/token$/);
  });

  test('defines the identity and token-sharing scope sets and the API resource', () => {
    expect(OPENAI_IDENTITY_SCOPE.split(' ')).toEqual(['openid', 'profile', 'email']);
    expect(OPENAI_TOKEN_SHARING_SCOPE.split(' ')).toEqual([
      'openid',
      'profile',
      'email',
      'offline_access',
      'resource.invoke',
      'chatpass.enable.request',
    ]);
    expect(OPENAI_RESOURCE).toBe('https://api.openai.com/v1');
  });

  test('recognises a delegated token-sharing grant and rejects an identity-only one', () => {
    expect(isOpenAiTokenSharingGrant({ scope: OPENAI_TOKEN_SHARING_SCOPE })).toBe(true);
    expect(isOpenAiTokenSharingGrant({ scope: OPENAI_IDENTITY_SCOPE })).toBe(false);
    // Each delegated scope is required: offline_access alone, or resource.invoke
    // alone, does not make the pair a usable BYOK credential.
    expect(isOpenAiTokenSharingGrant({ scope: 'openid profile email offline_access' })).toBe(false);
    expect(isOpenAiTokenSharingGrant({ scope: 'openid profile email resource.invoke' })).toBe(
      false
    );
    // A grant that can call the resource and refresh, but that declined the
    // ChatGPT allowance consent, must stay an identity sign-in: token sharing
    // cannot spend the allowance without `chatpass.enable.request`.
    expect(
      isOpenAiTokenSharingGrant({
        scope: 'openid profile email resource.invoke offline_access',
      })
    ).toBe(false);
    // RFC 6749 §5.1 lets the response omit `scope`; the refresh token is then the
    // marker that offline_access, and so the delegated flow, was granted.
    expect(isOpenAiTokenSharingGrant({ refresh_token: 'refresh-token' })).toBe(true);
    expect(isOpenAiTokenSharingGrant({ scope: '   ', refresh_token: 'refresh-token' })).toBe(true);
    expect(isOpenAiTokenSharingGrant({})).toBe(false);
    expect(isOpenAiTokenSharingGrant({ scope: OPENAI_IDENTITY_SCOPE, refresh_token: null })).toBe(
      false
    );
  });

  test('reads OPENAI_CLIENT_ID from the environment at module load', () => {
    const previous = process.env.OPENAI_CLIENT_ID;
    process.env.OPENAI_CLIENT_ID = 'oaiapp_test_value_from_env';
    try {
      let clientId: string | undefined;
      jest.isolateModules(() => {
        const configServer = jest.requireActual<{ OPENAI_CLIENT_ID: string }>(
          '@/lib/config.server'
        );
        clientId = configServer.OPENAI_CLIENT_ID;
      });
      expect(clientId).toBe('oaiapp_test_value_from_env');
    } finally {
      if (previous === undefined) {
        delete process.env.OPENAI_CLIENT_ID;
      } else {
        process.env.OPENAI_CLIENT_ID = previous;
      }
    }
  });

  test('never hard-codes the registered client id in server source', () => {
    expect(scannerFiles.some(file => file.endsWith(path.join('openai', 'config.ts')))).toBe(true);

    for (const file of scannerFiles) {
      expect(readFileSync(file, 'utf8')).not.toContain(FORBIDDEN_CLIENT_ID_LITERAL);
    }
  });
});
