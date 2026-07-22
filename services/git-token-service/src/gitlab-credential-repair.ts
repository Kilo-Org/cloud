import type { WorkerDb } from '@kilocode/db/client';
import { platform_integrations, platform_oauth_credentials } from '@kilocode/db/schema';
import {
  GITLAB_OAUTH_CREDENTIAL_ENVELOPE_SCHEME,
  GitLabOAuthCredentialRowSchema,
  buildGitLabOAuthCredentialAad,
  type GitLabCredentialOwner,
} from '@kilocode/worker-utils/gitlab-credential';
import { and, asc, eq, gt, isNotNull } from 'drizzle-orm';
import { z } from 'zod';
import { DEFAULT_GITLAB_INSTANCE_URL } from './gitlab-constants.js';
import type { GitLabCredentialCrypto } from './gitlab-credential-crypto.js';
import { normalizeGitLabInstanceUrl } from './gitlab-url.js';

export const GitLabCredentialRepairRequestSchema = z
  .object({
    afterId: z.uuid().optional(),
    limit: z.number().int().min(1).max(100).default(100),
  })
  .strict();

export type GitLabCredentialRepairRequest = z.infer<typeof GitLabCredentialRepairRequestSchema>;

type RepairParent = {
  id: string;
  platform: string;
  integration_type: string;
  platform_account_id: string | null;
  platform_account_login: string | null;
  owned_by_user_id: string | null;
  owned_by_organization_id: string | null;
  metadata: unknown;
};

export type GitLabCredentialRepairRow = {
  parent: RepairParent;
  credential: { id: string } & Record<string, unknown>;
};

export type GitLabCredentialRepairStore = {
  listCandidates(input: {
    afterId?: string;
    limit: number;
  }): Promise<{ rows: GitLabCredentialRepairRow[]; nextCursor: string | null }>;
  rewrapClientSecret(input: {
    credentialId: string;
    credentialVersion: number;
    previousCiphertext: string;
    nextCiphertext: string;
  }): Promise<boolean>;
};

export function buildGitLabCredentialRepairQuery(db: WorkerDb, afterId?: string) {
  return db
    .select({ parent: platform_integrations, credential: platform_oauth_credentials })
    .from(platform_oauth_credentials)
    .innerJoin(
      platform_integrations,
      eq(platform_integrations.id, platform_oauth_credentials.platform_integration_id)
    )
    .where(
      and(
        eq(platform_integrations.platform, 'gitlab'),
        eq(platform_integrations.integration_type, 'oauth'),
        isNotNull(platform_oauth_credentials.oauth_client_secret_encrypted),
        gt(platform_oauth_credentials.credential_version, 1),
        ...(afterId ? [gt(platform_oauth_credentials.id, afterId)] : [])
      )
    )
    .orderBy(asc(platform_oauth_credentials.id));
}

export class DrizzleGitLabCredentialRepairStore implements GitLabCredentialRepairStore {
  constructor(private db: WorkerDb) {}

  async listCandidates(input: { afterId?: string; limit: number }) {
    const rows = await buildGitLabCredentialRepairQuery(this.db, input.afterId).limit(
      input.limit + 1
    );
    const selected = rows.slice(0, input.limit);
    return {
      rows: selected,
      nextCursor: rows.length > input.limit ? (selected.at(-1)?.credential.id ?? null) : null,
    };
  }

  async rewrapClientSecret(input: {
    credentialId: string;
    credentialVersion: number;
    previousCiphertext: string;
    nextCiphertext: string;
  }): Promise<boolean> {
    const [updated] = await this.db
      .update(platform_oauth_credentials)
      .set({ oauth_client_secret_encrypted: input.nextCiphertext })
      .where(
        and(
          eq(platform_oauth_credentials.id, input.credentialId),
          eq(platform_oauth_credentials.credential_version, input.credentialVersion),
          eq(platform_oauth_credentials.oauth_client_secret_encrypted, input.previousCiphertext)
        )
      )
      .returning({ id: platform_oauth_credentials.id });
    return updated !== undefined;
  }
}

type RepairId = { integrationId: string; credentialId: string };
type RepairFailure =
  | 'profile'
  | 'configuration'
  | 'parse'
  | 'unknownKey'
  | 'unrepairable'
  | 'writeConflict';

function parentOwner(parent: RepairParent): GitLabCredentialOwner | null {
  if (parent.owned_by_user_id && parent.owned_by_organization_id === null) {
    return { type: 'user', id: parent.owned_by_user_id };
  }
  if (parent.owned_by_organization_id && parent.owned_by_user_id === null) {
    return { type: 'org', id: parent.owned_by_organization_id };
  }
  return null;
}

function parentBaseUrl(parent: RepairParent): string | null {
  if (
    parent.metadata === null ||
    typeof parent.metadata !== 'object' ||
    Array.isArray(parent.metadata)
  ) {
    return null;
  }
  const value = (parent.metadata as Record<string, unknown>).gitlab_instance_url;
  if (value !== undefined && typeof value !== 'string') return null;
  return normalizeGitLabInstanceUrl(value ?? DEFAULT_GITLAB_INSTANCE_URL);
}

function classifyFailure(
  status: Exclude<
    Awaited<ReturnType<GitLabCredentialCrypto['auditDecrypt']>>['status'],
    'available' | 'decrypt_failed'
  >
): RepairFailure {
  switch (status) {
    case 'configuration_error':
      return 'configuration';
    case 'invalid_envelope':
      return 'parse';
    case 'unknown_key':
      return 'unknownKey';
  }
}

export class GitLabCredentialRepairService {
  constructor(
    private store: GitLabCredentialRepairStore,
    private crypto: Pick<GitLabCredentialCrypto, 'auditDecrypt' | 'encrypt'>
  ) {}

  async repair(input: GitLabCredentialRepairRequest) {
    const page = await this.store.listCandidates(input);
    const failures: Record<RepairFailure, RepairId[]> = {
      profile: [],
      configuration: [],
      parse: [],
      unknownKey: [],
      unrepairable: [],
      writeConflict: [],
    };
    let repaired = 0;
    let alreadyHealthy = 0;

    for (const row of page.rows) {
      const id = { integrationId: row.parent.id, credentialId: row.credential.id };
      const parsed = GitLabOAuthCredentialRowSchema.safeParse(row.credential);
      const owner = parentOwner(row.parent);
      const providerBaseUrl = parentBaseUrl(row.parent);
      if (
        !parsed.success ||
        !owner ||
        !providerBaseUrl ||
        row.parent.platform !== 'gitlab' ||
        row.parent.integration_type !== 'oauth' ||
        row.parent.id !== parsed.data.platform_integration_id ||
        parsed.data.provider_base_url !== providerBaseUrl ||
        parsed.data.provider_subject_id !== row.parent.platform_account_id ||
        parsed.data.provider_subject_login !== row.parent.platform_account_login ||
        (owner.type === 'user' && parsed.data.authorized_by_user_id !== owner.id) ||
        !parsed.data.oauth_client_secret_encrypted ||
        parsed.data.credential_version <= 1
      ) {
        failures.profile.push(id);
        continue;
      }

      const credential = parsed.data;
      const clientSecretCiphertext = credential.oauth_client_secret_encrypted;
      if (!clientSecretCiphertext) {
        failures.profile.push(id);
        continue;
      }
      const aad = (credentialVersion: number) =>
        buildGitLabOAuthCredentialAad({
          credentialId: credential.id,
          integrationId: credential.platform_integration_id,
          providerBaseUrl: credential.provider_base_url,
          owner,
          authorizedByUserId: credential.authorized_by_user_id,
          credentialVersion,
          kind: 'oauth-client-secret',
        });
      const decrypt = async (credentialVersion: number) =>
        this.crypto.auditDecrypt({
          ciphertext: clientSecretCiphertext,
          scheme: GITLAB_OAUTH_CREDENTIAL_ENVELOPE_SCHEME,
          aad: aad(credentialVersion),
        });

      let current;
      try {
        current = await decrypt(credential.credential_version);
      } catch {
        failures.unrepairable.push(id);
        continue;
      }
      if (current.status === 'available') {
        alreadyHealthy += 1;
        continue;
      }
      if (current.status !== 'decrypt_failed') {
        failures[classifyFailure(current.status)].push(id);
        continue;
      }

      let previous;
      try {
        previous = await decrypt(credential.credential_version - 1);
      } catch {
        failures.unrepairable.push(id);
        continue;
      }
      if (previous.status !== 'available') {
        if (previous.status === 'decrypt_failed') failures.unrepairable.push(id);
        else failures[classifyFailure(previous.status)].push(id);
        continue;
      }

      const encrypted = await this.crypto.encrypt({
        plaintext: previous.token,
        scheme: GITLAB_OAUTH_CREDENTIAL_ENVELOPE_SCHEME,
        aad: aad(credential.credential_version),
      });
      if (encrypted.status !== 'available') {
        failures.configuration.push(id);
        continue;
      }
      const updated = await this.store.rewrapClientSecret({
        credentialId: credential.id,
        credentialVersion: credential.credential_version,
        previousCiphertext: clientSecretCiphertext,
        nextCiphertext: encrypted.ciphertext,
      });
      if (!updated) {
        failures.writeConflict.push(id);
        continue;
      }
      repaired += 1;
    }

    return {
      counts: {
        candidates: page.rows.length,
        repaired,
        alreadyHealthy,
        profileFailures: failures.profile.length,
        configurationFailures: failures.configuration.length,
        parseFailures: failures.parse.length,
        unknownKeyFailures: failures.unknownKey.length,
        unrepairableFailures: failures.unrepairable.length,
        writeConflicts: failures.writeConflict.length,
      },
      failures,
      nextCursor: page.nextCursor,
    };
  }
}
