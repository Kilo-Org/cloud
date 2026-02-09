import { NextResponse } from 'next/server';
import { preferredModels } from '@/lib/models';

export const revalidate = 3600; // cache for 1 hour

/**
 * Returns the list of recommended model public_id strings.
 * Consumed by the o11y worker to determine which models are eligible
 * for page-level SLO alerting.
 *
 * Test using:
 * curl -vvv 'http://localhost:3000/api/recommended-models'
 */
export function GET(): NextResponse<string[]> {
  return NextResponse.json(preferredModels);
}
