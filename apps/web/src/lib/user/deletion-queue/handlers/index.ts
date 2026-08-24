import { UserDeletionStepKey } from '@kilocode/db/schema-types';
import type { DeletionHandler } from '@/lib/user/deletion-queue/handlers/common';
import { handleAnonymize } from '@/lib/user/deletion-queue/handlers/anonymize';
import { handleCliV1Blobs } from '@/lib/user/deletion-queue/handlers/cli-v1';
import { handleCliV2Sessions } from '@/lib/user/deletion-queue/handlers/cli-v2';
import { handleCustomerio } from '@/lib/user/deletion-queue/handlers/customerio';
import { handleKiloclawDestroy } from '@/lib/user/deletion-queue/handlers/kiloclaw';
import { handlePosthog } from '@/lib/user/deletion-queue/handlers/posthog';
import { handleCsaSupportDb } from '@/lib/user/deletion-queue/handlers/csa-support-db';
import { handlePylonContact } from '@/lib/user/deletion-queue/handlers/pylon-contact';
import { handlePylonFinalize } from '@/lib/user/deletion-queue/handlers/pylon-finalize';
import { handlePylonReply } from '@/lib/user/deletion-queue/handlers/pylon-reply';
import { handleSubstack } from '@/lib/user/deletion-queue/handlers/substack';
import { handleUsagePromptPrefixes } from '@/lib/user/deletion-queue/handlers/usage-prompt-prefixes';

export type { DeletionHandler } from '@/lib/user/deletion-queue/handlers/common';

const handlers = {
  [UserDeletionStepKey.KiloclawDestroy]: handleKiloclawDestroy,
  [UserDeletionStepKey.Customerio]: handleCustomerio,
  [UserDeletionStepKey.CliV1Blobs]: handleCliV1Blobs,
  [UserDeletionStepKey.CliV2Sessions]: handleCliV2Sessions,
  [UserDeletionStepKey.UsagePromptPrefixes]: handleUsagePromptPrefixes,
  [UserDeletionStepKey.Posthog]: handlePosthog,
  [UserDeletionStepKey.Substack]: handleSubstack,
  [UserDeletionStepKey.Anonymize]: handleAnonymize,
  [UserDeletionStepKey.PylonReply]: handlePylonReply,
  [UserDeletionStepKey.PylonFinalize]: handlePylonFinalize,
  [UserDeletionStepKey.PylonContact]: handlePylonContact,
  [UserDeletionStepKey.CsaSupportDb]: handleCsaSupportDb,
} as const satisfies Record<UserDeletionStepKey, DeletionHandler>;

export function getDeletionHandler(stepKey: UserDeletionStepKey): DeletionHandler {
  return handlers[stepKey];
}
