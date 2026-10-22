/**
 * Browser-safe entry point for local config import. Owns bounded archive
 * decode, normalization, and semantic mapping against the intersection of the
 * profile storage contract and the runtime session contract.
 *
 * This module must not import drizzle-orm, @trpc/server, or the @kilocode/db
 * root entry point so the Next.js client bundle stays clean; only the pure
 * @kilocode/db/schema-types subpath is reachable through the shared validators.
 */
export {
  collectImportItems,
  type ImportCategory,
  type ImportedAgent,
  type ImportedInstruction,
  type ImportedKiloCommand,
  type ImportedSkill,
  type ImportIssue,
  type ImportIssueCode,
  type ImportIssueSeverity,
  type ImportItem,
  type ImportPreview,
  type ParsedLocalConfig,
} from './types';

export {
  decodeConfigArchive,
  decodeSkillBundleArchive,
  resolveConfigRoot,
  resolveSkillBundleRoot,
  ImportArchiveError,
  type ArchiveEntry,
  type DecodedConfigArchive,
  type ImportArchiveErrorCode,
} from './archive';

export {
  isImportArchiveWithinLimit,
  isImportEncodedWithinLimit,
  MAX_IMPORT_ARCHIVE_ENTRIES,
  MAX_IMPORT_ARCHIVE_EXPANDED_BYTES,
  MAX_IMPORT_ENCODED_LENGTH,
  MAX_IMPORT_ENTRY_EXPANDED_BYTES,
  MAX_IMPORT_REQUEST_BODY_BYTES,
  MAX_IMPORT_ZIP_BYTES,
} from './limits';

export { parseLocalConfigArchive } from './parse';

export {
  IMPORT_CATEGORIES,
  importItemId,
  selectImportItems,
  type ImportSelection,
  type SelectImportItemsResult,
} from './selection';

export {
  instructionImportSchema,
  instructionNameForPath,
  instructionNameSchema,
  MAX_IMPORT_INSTRUCTION_LENGTH,
  MAX_IMPORT_INSTRUCTION_NAME_LENGTH,
  MAX_IMPORT_INSTRUCTIONS,
  RESERVED_INSTRUCTION_NAMES,
  slugifyInstructionName,
} from './instructions';

export {
  RUNTIME_BUILTIN_AGENT_SLUGS,
  RUNTIME_LIMITS,
  RuntimeAgentContractSchema,
  RuntimeAgentsContractSchema,
  RuntimeKiloCommandContractSchema,
  RuntimeKiloCommandsContractSchema,
  RuntimeSkillContractSchema,
  RuntimeSkillsContractSchema,
} from './runtime-contract';
