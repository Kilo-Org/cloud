import { expect, it } from '@jest/globals';
import { handleSystemOneRequest } from '@kilocode/web-shared/lib/ai-gateway/typesafe/handler';
import { maxDuration, POST } from './route';

jest.mock('@kilocode/web-shared/lib/ai-gateway/typesafe/handler', () => ({
  handleSystemOneRequest: jest.fn(),
}));

it('exposes the System One handler with the gateway duration limit', () => {
  expect(POST).toBe(handleSystemOneRequest);
  expect(maxDuration).toBe(800);
});
