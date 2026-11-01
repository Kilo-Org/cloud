import { ScreenHeader } from '@/components/screen-header';
import { useAgentProfileOverview } from '@/lib/hooks/use-agent-profiles';

/**
 * The header every profile-editor section screen shares.
 *
 * A section screen edits one collection of one profile, and an organization has
 * several profiles side by side: the section label alone ("Profile agents")
 * leaves the reader unable to tell which of them the screen is changing. The
 * profile name goes under the title as the header's subtitle, in the same
 * normal-case treatment the Overview header gives it.
 *
 * The name comes from the Overview read, which is the query the screen above
 * this one already runs: a section pushed from there renders it from cache, and
 * a cold deep link pays one small summary read. The subtitle line is reserved
 * whether or not the name is known yet, so the arrival of a long name cannot
 * move the body.
 */
export function ProfileSectionHeader({
  profileId,
  organizationId,
  title,
  onBack,
}: Readonly<{
  profileId: string;
  organizationId?: string;
  /** The section's own label: the screen's title and its accessible header name. */
  title: string;
  onBack?: () => void;
}>) {
  const overview = useAgentProfileOverview(profileId, organizationId);
  return (
    <ScreenHeader title={title} subtitle={overview.data?.name} reserveSubtitle onBack={onBack} />
  );
}
