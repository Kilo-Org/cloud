import { useRouter } from 'expo-router';

import { McpFormSheet } from '@/components/profiles/mcp-form-sheet';

/**
 * The add-MCP-server sheet on a new server, empty, in its local-server state.
 * The sheet is a page sheet the profile's MCP screen opens, so reaching it by
 * hand costs a profile, the Add action and a sheet. Closing leaves the route,
 * and saving is refused on purpose: the fixture must not create a server on the
 * account that runs it.
 */
export function McpFormSheetFixture() {
  const router = useRouter();
  return (
    <McpFormSheet
      server={null}
      existingNames={[]}
      isSaving={false}
      onClose={() => {
        router.back();
      }}
      onSave={() => undefined}
    />
  );
}
