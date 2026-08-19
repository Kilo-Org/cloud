import { UserDeletionStepKey } from '@kilocode/db/schema-types';
import {
  USER_DELETION_CATALOG_VERSION,
  USER_DELETION_MAX_ORDINARY_ATTEMPTS,
} from '@/lib/user/deletion-queue/deletion-constants';

export const UserDeletionPhase = {
  Teardown: 'teardown',
  Anonymize: 'anonymize',
  Finalize: 'finalize',
} as const;

export type UserDeletionPhase = (typeof UserDeletionPhase)[keyof typeof UserDeletionPhase];

export type UserDeletionCatalogEntry = {
  stepKey: UserDeletionStepKey;
  phase: UserDeletionPhase;
  maxOrdinaryAttempts: number;
  dependsOn: readonly UserDeletionStepKey[];
  allowsManualVerification: boolean;
};

const TEARDOWN_KEYS = [
  UserDeletionStepKey.KiloclawDestroy,
  UserDeletionStepKey.Customerio,
  UserDeletionStepKey.CliV1Blobs,
  UserDeletionStepKey.CliV2Sessions,
  UserDeletionStepKey.UsagePromptPrefixes,
  // Temporarily handled by Customer Support Automation (CSA)
  // UserDeletionStepKey.Posthog,
  // UserDeletionStepKey.Substack,
] as const;

export const USER_DELETION_CATALOG_V1 = [
  {
    stepKey: UserDeletionStepKey.KiloclawDestroy,
    phase: UserDeletionPhase.Teardown,
    maxOrdinaryAttempts: USER_DELETION_MAX_ORDINARY_ATTEMPTS,
    dependsOn: [],
    allowsManualVerification: true,
  },
  {
    stepKey: UserDeletionStepKey.Customerio,
    phase: UserDeletionPhase.Teardown,
    maxOrdinaryAttempts: USER_DELETION_MAX_ORDINARY_ATTEMPTS,
    dependsOn: [],
    allowsManualVerification: true,
  },
  {
    stepKey: UserDeletionStepKey.CliV1Blobs,
    phase: UserDeletionPhase.Teardown,
    maxOrdinaryAttempts: USER_DELETION_MAX_ORDINARY_ATTEMPTS,
    dependsOn: [],
    allowsManualVerification: true,
  },
  {
    stepKey: UserDeletionStepKey.CliV2Sessions,
    phase: UserDeletionPhase.Teardown,
    maxOrdinaryAttempts: USER_DELETION_MAX_ORDINARY_ATTEMPTS,
    dependsOn: [],
    allowsManualVerification: true,
  },
  {
    stepKey: UserDeletionStepKey.UsagePromptPrefixes,
    phase: UserDeletionPhase.Teardown,
    maxOrdinaryAttempts: USER_DELETION_MAX_ORDINARY_ATTEMPTS,
    dependsOn: [],
    allowsManualVerification: false,
  },
  // Temporarily handled by Customer Support Automation (CSA)
  // {
  //   stepKey: UserDeletionStepKey.Posthog,
  //   phase: UserDeletionPhase.Teardown,
  //   maxOrdinaryAttempts: USER_DELETION_MAX_ORDINARY_ATTEMPTS,
  //   dependsOn: [],
  //   allowsManualVerification: true,
  // },
  // {
  //   stepKey: UserDeletionStepKey.Substack,
  //   phase: UserDeletionPhase.Teardown,
  //   maxOrdinaryAttempts: USER_DELETION_MAX_ORDINARY_ATTEMPTS,
  //   dependsOn: [],
  //   allowsManualVerification: true,
  // },
  {
    stepKey: UserDeletionStepKey.Anonymize,
    phase: UserDeletionPhase.Anonymize,
    maxOrdinaryAttempts: USER_DELETION_MAX_ORDINARY_ATTEMPTS,
    dependsOn: TEARDOWN_KEYS,
    allowsManualVerification: false,
  },
  // Temporarily handled by Customer Support Automation (CSA)
  // {
  //   stepKey: UserDeletionStepKey.PylonReply,
  //   phase: UserDeletionPhase.Finalize,
  //   maxOrdinaryAttempts: USER_DELETION_MAX_ORDINARY_ATTEMPTS,
  //   dependsOn: [...TEARDOWN_KEYS, UserDeletionStepKey.Anonymize],
  //   allowsManualVerification: true,
  // },
  // {
  //   stepKey: UserDeletionStepKey.PylonContact,
  //   phase: UserDeletionPhase.Finalize,
  //   maxOrdinaryAttempts: USER_DELETION_MAX_ORDINARY_ATTEMPTS,
  //   dependsOn: [UserDeletionStepKey.PylonReply],
  //   allowsManualVerification: true,
  // },
] as const satisfies readonly UserDeletionCatalogEntry[];

export function catalogForVersion(version: number): readonly UserDeletionCatalogEntry[] {
  if (version !== USER_DELETION_CATALOG_VERSION) {
    throw new Error(`Unsupported user deletion catalog version ${version}`);
  }
  return USER_DELETION_CATALOG_V1;
}

export function catalogEntryFor(
  version: number,
  stepKey: UserDeletionStepKey
): UserDeletionCatalogEntry {
  const entry = catalogForVersion(version).find(candidate => candidate.stepKey === stepKey);
  if (!entry) {
    throw new Error(`Unknown user deletion step ${stepKey} for catalog version ${version}`);
  }
  return entry;
}

export function teardownStepKeys(): readonly UserDeletionStepKey[] {
  return TEARDOWN_KEYS;
}

export function preReplyStepKeys(): readonly UserDeletionStepKey[] {
  return [...TEARDOWN_KEYS, UserDeletionStepKey.Anonymize];
}
