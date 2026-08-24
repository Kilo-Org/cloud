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

const V1_TEARDOWN_KEYS = [
  UserDeletionStepKey.KiloclawDestroy,
  UserDeletionStepKey.Customerio,
  UserDeletionStepKey.CliV1Blobs,
  UserDeletionStepKey.CliV2Sessions,
  UserDeletionStepKey.UsagePromptPrefixes,
] as const;

const V2_TEARDOWN_KEYS = [
  ...V1_TEARDOWN_KEYS,
  UserDeletionStepKey.Posthog,
  UserDeletionStepKey.Substack,
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
  {
    stepKey: UserDeletionStepKey.Anonymize,
    phase: UserDeletionPhase.Anonymize,
    maxOrdinaryAttempts: USER_DELETION_MAX_ORDINARY_ATTEMPTS,
    dependsOn: V1_TEARDOWN_KEYS,
    allowsManualVerification: false,
  },
] as const satisfies readonly UserDeletionCatalogEntry[];

export const USER_DELETION_CATALOG_V2 = [
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
  {
    stepKey: UserDeletionStepKey.Posthog,
    phase: UserDeletionPhase.Teardown,
    maxOrdinaryAttempts: USER_DELETION_MAX_ORDINARY_ATTEMPTS,
    dependsOn: [],
    allowsManualVerification: true,
  },
  {
    stepKey: UserDeletionStepKey.Substack,
    phase: UserDeletionPhase.Teardown,
    maxOrdinaryAttempts: USER_DELETION_MAX_ORDINARY_ATTEMPTS,
    dependsOn: [],
    allowsManualVerification: true,
  },
  {
    stepKey: UserDeletionStepKey.Anonymize,
    phase: UserDeletionPhase.Anonymize,
    maxOrdinaryAttempts: USER_DELETION_MAX_ORDINARY_ATTEMPTS,
    dependsOn: V2_TEARDOWN_KEYS,
    allowsManualVerification: false,
  },
  {
    stepKey: UserDeletionStepKey.PylonReply,
    phase: UserDeletionPhase.Finalize,
    maxOrdinaryAttempts: USER_DELETION_MAX_ORDINARY_ATTEMPTS,
    dependsOn: [...V2_TEARDOWN_KEYS, UserDeletionStepKey.Anonymize],
    allowsManualVerification: true,
  },
  {
    stepKey: UserDeletionStepKey.PylonFinalize,
    phase: UserDeletionPhase.Finalize,
    maxOrdinaryAttempts: USER_DELETION_MAX_ORDINARY_ATTEMPTS,
    dependsOn: [UserDeletionStepKey.PylonReply],
    allowsManualVerification: true,
  },
  {
    stepKey: UserDeletionStepKey.PylonContact,
    phase: UserDeletionPhase.Finalize,
    maxOrdinaryAttempts: USER_DELETION_MAX_ORDINARY_ATTEMPTS,
    dependsOn: [UserDeletionStepKey.PylonFinalize],
    allowsManualVerification: true,
  },
  {
    stepKey: UserDeletionStepKey.CsaSupportDb,
    phase: UserDeletionPhase.Finalize,
    maxOrdinaryAttempts: USER_DELETION_MAX_ORDINARY_ATTEMPTS,
    dependsOn: [UserDeletionStepKey.PylonContact],
    allowsManualVerification: true,
  },
] as const satisfies readonly UserDeletionCatalogEntry[];

export function catalogForVersion(version: number): readonly UserDeletionCatalogEntry[] {
  if (version === 1) return USER_DELETION_CATALOG_V1;
  if (version === 2) return USER_DELETION_CATALOG_V2;
  throw new Error(`Unsupported user deletion catalog version ${version}`);
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

export function teardownStepKeys(
  version: number = USER_DELETION_CATALOG_VERSION
): readonly UserDeletionStepKey[] {
  return catalogForVersion(version)
    .filter(entry => entry.phase === UserDeletionPhase.Teardown)
    .map(entry => entry.stepKey);
}

export function preReplyStepKeys(
  version: number = USER_DELETION_CATALOG_VERSION
): readonly UserDeletionStepKey[] {
  return [...teardownStepKeys(version), UserDeletionStepKey.Anonymize];
}
