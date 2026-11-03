import { useTranslation } from 'react-i18next';

import { Text } from '@/components/ui/text';

/**
 * The one line under the Bitbucket organization-only explanation. It names the
 * account switch only when the memberships answer says there is somewhere to
 * switch to, and says so plainly when the account belongs to no organization.
 * A failed read gets no line of its own: the context line above already reports
 * the failure with a retry, and neither wording is true of an unknown list.
 */
export function OrgOnlyDescription({
  membershipsError,
  organizationCount,
}: Readonly<{
  membershipsError: boolean;
  /** Undefined until the memberships answer lands. */
  organizationCount: number | undefined;
}>) {
  const { t } = useTranslation();
  if (membershipsError) {
    return null;
  }
  return (
    <Text variant="muted" className="text-center">
      {organizationCount === 0
        ? t('prReview.connect.bitbucketOrgOnlyNoOrganizationDescription')
        : t('prReview.connect.bitbucketOrgOnlyDescription')}
    </Text>
  );
}
