import { getRandomNumber } from '@/lib/ai-gateway/getRandomNumber';

export type RoutingCohort = 'vercel' | 'friendli' | 'perplexity';

export function passesRoutingPercentage(
  cohort: RoutingCohort,
  randomSeed: string,
  routingPercentage: number
) {
  const routingSeed = `${cohort}_routing_${randomSeed}`;
  const wholePercentageBucket = getRandomNumber(routingSeed, 100);
  const fractionalPercentageBucket = getRandomNumber(routingSeed + '_fractional', 1_000);

  return wholePercentageBucket + fractionalPercentageBucket / 1_000 < routingPercentage;
}
