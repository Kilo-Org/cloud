import {
  type ProfileSelectorOwnerType,
  type ProfileSelectorProfile,
} from '@/components/agents/profile-selector-model';

/**
 * One row of a profile list read, as both shapes carry it: the personal array
 * and the combined buckets hold the same summary fields.
 */
export type ProfileListRow = Readonly<{
  id: string;
  name: string;
  varCount: number;
  commandCount: number;
  isDefault: boolean;
  ownerType?: ProfileSelectorOwnerType;
}>;

/**
 * One list row as the selector renders it. A row from the combined read carries
 * its own owner, so the personal bucket inside an organization context keeps
 * saying `user`; the scope's owner is only the fallback for a row without one.
 */
export function toSelectorProfile(
  profile: ProfileListRow,
  fallbackOwnerType: ProfileSelectorOwnerType
): ProfileSelectorProfile {
  return {
    id: profile.id,
    name: profile.name,
    varCount: profile.varCount,
    commandCount: profile.commandCount,
    isDefault: profile.isDefault,
    ownerType: profile.ownerType ?? fallbackOwnerType,
  };
}
