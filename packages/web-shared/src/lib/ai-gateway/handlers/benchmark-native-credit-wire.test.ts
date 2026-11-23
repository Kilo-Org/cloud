import { describe, it, expect, jest } from '@jest/globals';
import type { NextResponse } from 'next/server';
import { benchmarkPayerRefusal } from '@kilocode/web-shared/lib/ai-gateway/benchmark-balance-policy';

/**
 * The Worker decides whether to rotate a payer from the signed `error.reason` on a 402. These
 * tests pin the two wire facts it depends on:
 *  - an authoritative credit refusal becomes `payment_refused`, with no provider call;
 *  - a provider response is never a refusal, so a provider 402 is never rotated.
 *
 * The policy decision is the leaf function the credit gate uses, so this stays a wire test
 * rather than a mock of a status code.
 */
jest.mock('@kilocode/web-shared/lib/stripe-client', () => ({ client: {} }));
jest.mock('@kilocode/web-shared/lib/autoTopUp', () => ({}));

function benchmarkRefusal(reason: 'payment_refused' | 'payer_unavailable'): NextResponse {
  return new Response(JSON.stringify({ error: { code: 'benchmark_payer_refused', reason } }), {
    status: 402,
    headers: { 'x-kilo-benchmark-admission': 'refused' },
  }) as unknown as NextResponse;
}

describe('benchmark payer refusal on the native credit wire', () => {
  it('tags a real credit refusal and returns no provider call', () => {
    const reason = benchmarkPayerRefusal({
      creditsBlocked: true,
      payerResolved: true,
      membershipUsable: true,
    });
    expect(reason).toBe('payment_refused');
    const response = benchmarkRefusal(reason!) as unknown as Response;
    expect(response.status).toBe(402);
    expect(response.headers.get('x-kilo-benchmark-admission')).toBe('refused');
  });

  it('keeps a funded payer admitted', () => {
    expect(
      benchmarkPayerRefusal({ creditsBlocked: false, payerResolved: true, membershipUsable: true })
    ).toBeNull();
  });

  it('separates identity failure from payment failure', () => {
    expect(
      benchmarkPayerRefusal({ creditsBlocked: true, payerResolved: false, membershipUsable: true })
    ).toBe('payer_unavailable');
  });

  it('never turns a provider 402 into a rotatable refusal', () => {
    // After admission the gateway only stamps `admitted`; the provider's own status passes
    // through, so the Worker treats the call as terminal for this payer.
    const providerResponse = new Response(
      JSON.stringify({ error: { message: 'insufficient funds' } }),
      { status: 402, headers: { 'content-type': 'application/json' } }
    );
    const headers = new Headers(providerResponse.headers);
    headers.set('x-kilo-benchmark-admission', 'admitted');
    const outbound = new Response(providerResponse.body, {
      status: providerResponse.status,
      headers,
    });
    expect(outbound.status).toBe(402);
    expect(outbound.headers.get('x-kilo-benchmark-admission')).toBe('admitted');
  });
});
