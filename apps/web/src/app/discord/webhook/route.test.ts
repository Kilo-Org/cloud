import { NextRequest } from 'next/server';
import { InteractionType, InteractionResponseType } from 'discord-interactions';

jest.mock('@/lib/discord/verify-request', () => ({
  verifyDiscordRequest: jest.fn(),
}));
jest.mock('@/lib/config.server', () => ({
  DISCORD_BOT_TOKEN: 'test-bot-token',
  DISCORD_PUBLIC_KEY: 'test-public-key',
}));
jest.mock('@/lib/discord-bot', () => ({
  processDiscordBotMessage: jest.fn(),
}));
jest.mock('@/lib/integrations/discord-service', () => ({
  postDiscordMessage: jest.fn(),
  addDiscordReaction: jest.fn(),
  removeDiscordReaction: jest.fn(),
}));

import { POST } from './route';
import { verifyDiscordRequest } from '@/lib/discord/verify-request';

function makeRequest(rawBody: string) {
  return new NextRequest('http://localhost:3000/discord/webhook', {
    method: 'POST',
    // rawBody goes through request.text() in route. Keep body valid for Request.
    body: rawBody.length > 0 ? rawBody : ' ',
  });
}

describe('POST /discord/webhook interaction body', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    // Verify is mocked true. PING test checks body parse only, not verify path.
    jest.mocked(verifyDiscordRequest).mockResolvedValue(true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each([['not-json{'], ['null'], ['"just-a-string"'], ['[1,2,3]'], ['42'], ['true']])(
    'returns 400 with Invalid interaction payload for body %s',
    async rawBody => {
      const request = makeRequest(rawBody || ' ');
      jest.spyOn(request, 'text').mockResolvedValue(rawBody);
      const response = await POST(request);
      expect(response.status).toBe(400);
      expect(await response.text()).toBe('Invalid interaction payload');
    }
  );

  it.each([[''], [' ']])('returns 400 for blank body %s', async rawBody => {
    const request = makeRequest(' ');
    jest.spyOn(request, 'text').mockResolvedValue(rawBody);
    const response = await POST(request);
    expect(response.status).toBe(400);
    expect(await response.text()).toBe('Invalid interaction payload');
  });

  it('answers PING with PONG', async () => {
    const response = await POST(makeRequest(JSON.stringify({ type: InteractionType.PING })));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ type: InteractionResponseType.PONG });
  });
});
