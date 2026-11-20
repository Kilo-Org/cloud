import { expect, it } from '@jest/globals';
import { NextRequest, NextResponse } from 'next/server';
import { handleSystemOneRequest } from '@kilocode/web-shared/lib/ai-gateway/typesafe/handler';
import { maxDuration, POST } from './route';

jest.mock('@kilocode/web-shared/lib/ai-gateway/typesafe/handler', () => ({
  handleSystemOneRequest: jest.fn(),
}));

it('delegates to the System One handler with the gateway duration limit', async () => {
  const request = new NextRequest('https://ai-gateway.kilo.ai/api/v1/systemone', {
    method: 'POST',
  });
  const response = new NextResponse(null, { status: 204 });
  jest.mocked(handleSystemOneRequest).mockResolvedValue(response);

  await expect(POST(request)).resolves.toBe(response);
  expect(handleSystemOneRequest).toHaveBeenCalledTimes(1);
  expect(handleSystemOneRequest).toHaveBeenCalledWith(request);
  expect(maxDuration).toBe(800);
});
