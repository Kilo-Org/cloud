import { useRouter } from 'expo-router';

import { SaveProfileSheet } from '@/components/agents/save-profile-sheet';

/**
 * The Save as Profile sheet with the draft one variable and one setup command
 * make. The panel hands the sheet exactly these two lists, so the summary line
 * here is the one a session start shows. Reaching it by hand costs an expanded
 * Advanced Configuration panel, two editors and a save, so the design gate
 * opens it through this link instead.
 *
 * Closing leaves the route, and saving is refused on purpose: the fixture must
 * not create a profile on the account that runs it.
 */
export function SaveProfileSheetFixture() {
  const router = useRouter();
  return (
    <SaveProfileSheet
      envVars={[{ key: 'DEMO_KEY', value: '1', isSecret: false }]}
      setupCommands={['npm ci']}
      onClose={() => {
        router.back();
      }}
      onSave={() => Promise.resolve(false)}
    />
  );
}
