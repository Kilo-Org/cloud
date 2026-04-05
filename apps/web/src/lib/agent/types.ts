/** Owner type for agent environment profiles - exactly one of organizationId or userId must be set. */
export type ProfileOwner = { type: 'organization'; id: string } | { type: 'user'; id: string };

/** Owner type discriminator for UI display. */
export type ProfileOwnerType = ProfileOwner['type'];

/** Profile variable response type (for API responses). Secret values are masked. */
export type ProfileVarResponse = {
  key: string;
  value: string; // Masked as '***' for secrets
  isSecret: boolean;
  createdAt: string;
  updatedAt: string;
};

/** Profile command response type. */
export type ProfileCommandResponse = {
  sequence: number;
  command: string;
};

/** Profile response type for list/get operations. */
export type ProfileResponse = {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
  vars: ProfileVarResponse[];
  commands: ProfileCommandResponse[];
};

/** Profile response with owner type for combined listings. */
export type ProfileResponseWithOwner = ProfileResponse & {
  ownerType: ProfileOwnerType;
};

/** Profile summary for list operations (without vars/commands). */
export type ProfileSummary = {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
  varCount: number;
  commandCount: number;
};

/** Profile summary with owner type for combined listings. */
export type ProfileSummaryWithOwner = ProfileSummary & {
  ownerType: ProfileOwnerType;
};

/** Combined profiles result for org context - returns both org and personal profiles with effective default. */
export type CombinedProfilesResult = {
  orgProfiles: ProfileSummaryWithOwner[];
  personalProfiles: ProfileSummaryWithOwner[];
  effectiveDefaultId: string | null;
};
