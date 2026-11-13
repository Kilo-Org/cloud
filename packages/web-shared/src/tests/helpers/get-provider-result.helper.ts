import { expect } from '@jest/globals';
import type {
  GetProviderProviderResult,
  GetProviderResult,
  ProviderRoute,
} from '@kilocode/web-shared/lib/ai-gateway/providers/get-provider';

export function expectProviderResult(
  result: GetProviderResult
): asserts result is GetProviderProviderResult {
  if (result.kind !== 'provider') throw new Error(`expected provider result, got ${result.kind}`);
}

/** The route that takes the request. */
export async function firstRoute(result: GetProviderResult): Promise<ProviderRoute> {
  expectProviderResult(result);
  return result.routes[0]();
}

/** The route that takes the request, asserting no route follows it. */
export async function onlyRoute(result: GetProviderResult): Promise<ProviderRoute> {
  expect(result).toEqual({ kind: 'provider', routes: [expect.any(Function)] });
  return firstRoute(result);
}
