import { Stack, useLocalSearchParams } from 'expo-router';

import { PrReviewScreen } from '@/components/pr-review/pr-review-screen';

type Params = {
  owner: string;
  repo: string;
  number: string;
};

export default function PrReviewNumberIndexRoute() {
  const { owner, repo, number } = useLocalSearchParams<Params>();
  const numberValue = Number.parseInt(number, 10);

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <PrReviewScreen owner={owner} repo={repo} number={numberValue} />
    </>
  );
}
