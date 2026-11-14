import { Redirect } from 'expo-router';

import { McpFormSheetFixture } from '@/components/profiles/mcp-form-sheet-fixture';

export default function McpFormSheetFixtureRoute() {
  return __DEV__ ? <McpFormSheetFixture /> : <Redirect href="/(auth)/login" />;
}
