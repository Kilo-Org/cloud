import { useTranslation } from 'react-i18next';

import { type ProfileSectionKey } from '@/components/profiles/profile-list-model';
import { Text } from '@/components/ui/text';

/**
 * The owner words every profile surface uses: the heading above one owner's
 * group of rows, and the owner each row announces. The profile manager and the
 * session-start picker both read them here, so the two never name an owner
 * differently.
 *
 * `profiles.list.*` is the reviewed heading copy the translation slice will
 * carry; until it lands the heading keeps the generic English word the rest of
 * the app uses.
 */
export function useProfileOwnerLabel(): (owner: ProfileSectionKey) => string {
  const { t } = useTranslation();
  return owner => {
    const isOrganization = owner === 'organization';
    return t(
      isOrganization ? 'profiles.list.organizationHeading' : 'profiles.list.personalHeading',
      {
        defaultValue: t(isOrganization ? 'common.organization' : 'common.personal'),
      }
    );
  };
}

/**
 * The heading above one group of rows. Every group on a profile surface reads
 * it, so the owner groups and the settings group that follows them share one
 * text style.
 */
export function ProfileSectionHeading({ children }: Readonly<{ children: string }>) {
  return (
    <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
      {children}
    </Text>
  );
}

/** The heading above one owner's group of profile rows. */
export function ProfileOwnerHeading({ owner }: Readonly<{ owner: ProfileSectionKey }>) {
  const ownerLabel = useProfileOwnerLabel();
  return <ProfileSectionHeading>{ownerLabel(owner)}</ProfileSectionHeading>;
}
