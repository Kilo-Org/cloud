import { BUNDLE_DENIED_REASONS } from '@kilocode/sts-contracts';
import { z } from 'zod';
import { getDenialStub } from '../dos/stubs';
import type { Env, StsConfig } from '../env';

/**
 * A refused bundle read from a caller STS identified: a Worker with valid props, or a provider
 * token whose signature verified. Claims are the provider's stable ids (never the token).
 */
export type Denial = {
  channel: 'worker-binding' | 'http';
  reason: (typeof BUNDLE_DENIED_REASONS)[number];
  actor: string;
  claims: Record<string, string>;
};

export const DenialSchema: z.ZodType<Denial> = z.strictObject({
  channel: z.enum(['worker-binding', 'http']),
  reason: z.enum(BUNDLE_DENIED_REASONS),
  actor: z.string().min(1).max(256),
  claims: z
    .record(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), z.string().max(256))
    .refine(claims => Object.keys(claims).length <= 16, { message: 'at most 16 claims' }),
});

/** Identical denials in one minute merge into one row; this is the identity they merge on. */
export function denialKey(denial: Denial): string {
  const claims = Object.keys(denial.claims)
    .sort()
    .map(name => [name, denial.claims[name]]);
  return JSON.stringify([denial.channel, denial.reason, denial.actor, claims]);
}

/**
 * Hands one denial to the environment's denial object. It runs after the response (the caller
 * passes it to `waitUntil`), and a failure is logged: the read is refused either way.
 */
export async function recordDenial(env: Env, config: StsConfig, denial: Denial): Promise<void> {
  try {
    await getDenialStub(env, config).record(denial);
  } catch (error) {
    console.error('sts: bundle denial could not be recorded', {
      reason: denial.reason,
      channel: denial.channel,
      error: error instanceof Error ? error.name : 'unknown',
    });
  }
}
