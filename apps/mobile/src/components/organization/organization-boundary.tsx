import { type Href, useRouter } from 'expo-router';
import { Building2 } from 'lucide-react-native';
import { ActivityIndicator, View } from 'react-native';

import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

const PROFILE_HREF = '/(app)/(tabs)/(3_profile)' as Href;

type OrganizationBoundaryProps = Readonly<{
  /** Identity/org-list is still resolving — show a brief in-progress state instead of the empty state. */
  isResolving?: boolean;
  /** The underlying `organizations.list` query failed — a retryable fetch failure, not a stale org selection. */
  isError?: boolean;
  isFetching?: boolean;
  refetch?: () => unknown;
  /** Null when no organization has ever been selected — gets distinct copy from "selection no longer resolves". */
  organizationId?: string | null;
}>;

/**
 * Content shown in place of an organization screen or sheet when the org
 * context isn't ready to render the real content — never renders `null`, so
 * the route is never blank. Three distinct cases, in priority order:
 * 1. `isResolving` — identity/org-list still loading, brief spinner.
 * 2. `isError` — `organizations.list` itself failed to fetch; this is
 *    retryable and must NOT be conflated with a stale org selection.
 * 3. otherwise — the list loaded fine but the persisted `organizationId`
 *    doesn't resolve to a membership: either nothing was ever selected, or
 *    the selected org is stale (deleted / user removed). Each gets its own
 *    copy.
 * Callers own their own chrome (`ScreenHeader` for full screens, nothing for
 * form sheets) — this only renders the content.
 */
export function OrganizationBoundary({
  isResolving,
  isError,
  isFetching,
  refetch,
  organizationId,
}: OrganizationBoundaryProps = {}) {
  const router = useRouter();
  const colors = useThemeColors();

  if (isResolving) {
    return (
      <View className="flex-1 items-center justify-center">
        <ActivityIndicator color={colors.mutedForeground} />
      </View>
    );
  }

  if (isError) {
    return (
      <QueryError
        title="Couldn't load your organizations"
        description="Check your connection and try again."
        onRetry={refetch ? () => void refetch() : undefined}
        isRetrying={isFetching}
      />
    );
  }

  const noSelection = organizationId == null;

  return (
    <EmptyState
      icon={Building2}
      title={noSelection ? 'Select an organization' : 'Organization unavailable'}
      description={
        noSelection
          ? 'Choose an organization from your profile to continue.'
          : 'This organization is no longer available. Choose one from your profile to continue.'
      }
      action={
        <Button
          variant="outline"
          onPress={() => {
            router.replace(PROFILE_HREF);
          }}
        >
          <Text>Back to profile</Text>
        </Button>
      }
    />
  );
}
