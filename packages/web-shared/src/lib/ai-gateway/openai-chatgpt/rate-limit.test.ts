import { describe, expect, it } from '@jest/globals';

jest.mock('@vercel/firewall', () => ({ checkRateLimit: jest.fn() }));
jest.mock('@sentry/nextjs', () => ({ captureMessage: jest.fn() }));

import { checkRateLimit } from '@vercel/firewall';
import { NextRequest } from 'next/server';
import { isOpenAiChatGptRateLimited } from './rate-limit';
import { openAiChatGptSharedServicesOwner } from './store';

const mockCheckRateLimit = jest.mocked(checkRateLimit);

describe('isOpenAiChatGptRateLimited', () => {
  const request = new NextRequest('https://gateway.example.com/api/v1/responses');

  it.each([
    [
      'a personal connection',
      { kiloUserId: 'user-123', organizationId: null },
      'user-123:personal',
    ],
    [
      'an organization member connection',
      { kiloUserId: 'user-123', organizationId: 'org-1' },
      'user-123:org-1',
    ],
    [
      'an organization shared-services connection',
      openAiChatGptSharedServicesOwner('org-1'),
      'shared-services:org-1',
    ],
  ])('counts %s against its own bucket', async (_case, owner, key) => {
    mockCheckRateLimit.mockResolvedValue({ rateLimited: true });

    await expect(isOpenAiChatGptRateLimited(request, owner)).resolves.toBe(true);

    expect(mockCheckRateLimit).toHaveBeenCalledWith(
      'openai-chatgpt-inference',
      expect.objectContaining({ rateLimitKey: `openai-chatgpt-inference:${key}` })
    );
  });

  it('lets a connection under the limit through', async () => {
    mockCheckRateLimit.mockResolvedValue({ rateLimited: false });

    await expect(
      isOpenAiChatGptRateLimited(request, { kiloUserId: 'user-123', organizationId: null })
    ).resolves.toBe(false);
  });
});
