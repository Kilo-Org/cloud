import { Redirect } from 'expo-router';

import { QuestionCardFixture } from '@/components/agents/question-card-fixture';

export default function QuestionCardFixtureRoute() {
  return __DEV__ ? <QuestionCardFixture /> : <Redirect href="/(auth)/login" />;
}
