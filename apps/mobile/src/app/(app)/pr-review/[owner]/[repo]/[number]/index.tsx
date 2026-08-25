import { type Href, Stack, useLocalSearchParams } from 'expo-router';

import { InvalidRouteState } from '@/components/invalid-route-state';
import { PrReviewScreen } from '@/components/pr-review/pr-review-screen';
import { parseParam } from '@/lib/route-params';

type Params = {
  owner: string;
  repo: string;
  number: string;
};

export default function PrReviewNumberIndexRoute() {
  const { owner, repo, number } = useLocalSearchParams<Params>();
  const parsedOwner = parseParam(owner);
  const parsedRepo = parseParam(repo);
  const rawNumber = parseParam(number);
  const numberValue = rawNumber ? Number.parseInt(rawNumber, 10) : Number.NaN;

  if (!parsedOwner || !parsedRepo || !Number.isInteger(numberValue) || numberValue <= 0) {
    return <InvalidRouteState backTo={'/(app)/pr-review' as Href} />;
  }

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <PrReviewScreen owner={parsedOwner} repo={parsedRepo} number={numberValue} />
    </>
  );
}
