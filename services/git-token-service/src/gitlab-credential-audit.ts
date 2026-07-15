import type { WorkerDb } from '@kilocode/db/client';
import {
  platform_access_token_credentials,
  platform_integrations,
  platform_oauth_credentials,
} from '@kilocode/db/schema';
import {
  GITLAB_OAUTH_CREDENTIAL_ENVELOPE_SCHEME,
  GITLAB_PERSONAL_ACCESS_TOKEN_ENVELOPE_SCHEME,
  GITLAB_PROJECT_ACCESS_TOKEN_ENVELOPE_SCHEME,
  GitLabOAuthCredentialRowSchema,
  GitLabPersonalAccessTokenCredentialRowSchema,
  GitLabProjectAccessTokenCredentialRowSchema,
  buildGitLabOAuthCredentialAad,
  buildGitLabPersonalAccessTokenAad,
  buildGitLabProjectAccessTokenAad,
  type GitLabCredentialOwner,
} from '@kilocode/worker-utils/gitlab-credential';
import { and, asc, eq, gt } from 'drizzle-orm';
import { z } from 'zod';
import { DEFAULT_GITLAB_INSTANCE_URL } from './gitlab-constants.js';
import type { GitLabCredentialCrypto } from './gitlab-credential-crypto.js';
import { normalizeGitLabInstanceUrl } from './gitlab-url.js';

const AuditCursorSchema = z.string().refine(value => parseAuditCursor(value) !== null, {
  message: 'Invalid GitLab credential audit cursor',
});

export const GitLabCredentialAuditRequestSchema = z
  .object({
    cursor: AuditCursorSchema.optional(),
    limit: z.number().int().min(1).max(100).default(100),
  })
  .strict();

export type GitLabCredentialAuditRequest = z.infer<typeof GitLabCredentialAuditRequestSchema>;

type AuditTable = 'oauth' | 'access-token';
type AuditCursor = { table: AuditTable; afterId?: string };

type GitLabCredentialAuditParent = {
  id: string;
  platform: string;
  integration_type: string;
  integration_status: string | null;
  platform_account_id: string | null;
  platform_account_login: string | null;
  owned_by_user_id: string | null;
  owned_by_organization_id: string | null;
  metadata: unknown;
};

export type GitLabCredentialAuditRow = {
  table: AuditTable;
  parent: GitLabCredentialAuditParent;
  credential: { id: string } & Record<string, unknown>;
};

export type GitLabCredentialAuditPage = {
  rows: GitLabCredentialAuditRow[];
  nextCursor: string | null;
};

export type GitLabCredentialAuditStore = {
  listCredentials(input: { cursor?: string; limit: number }): Promise<GitLabCredentialAuditPage>;
};

type AuditId = { integrationId: string; credentialId: string };
type FailureKind = 'profile' | 'configuration' | 'parse' | 'unknownKey' | 'decryptOrAad';

type AuditSecret = {
  ciphertext: string;
  scheme:
    | typeof GITLAB_OAUTH_CREDENTIAL_ENVELOPE_SCHEME
    | typeof GITLAB_PERSONAL_ACCESS_TOKEN_ENVELOPE_SCHEME
    | typeof GITLAB_PROJECT_ACCESS_TOKEN_ENVELOPE_SCHEME;
  aad: string;
};

function parseAuditCursor(value: string): AuditCursor | null {
  if (value === 'access-token') return { table: 'access-token' };
  const match = /^(oauth|access-token):(.+)$/.exec(value);
  if (!match || !z.uuid().safeParse(match[2]).success) return null;
  return { table: match[1] as AuditTable, afterId: match[2] };
}

function encodeAuditCursor(cursor: AuditCursor): string {
  return cursor.afterId ? `${cursor.table}:${cursor.afterId}` : cursor.table;
}

function lastCredentialId(rows: Array<{ credential: { id: string } }>): string {
  const last = rows.at(-1);
  if (!last) throw new Error('Cannot paginate an empty credential batch');
  return last.credential.id;
}

export function buildGitLabOAuthCredentialAuditQuery(db: WorkerDb, afterId?: string) {
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
        ...(afterId ? [gt(platform_oauth_credentials.id, afterId)] : [])
      )
    )
    .orderBy(asc(platform_oauth_credentials.id));
}

export function buildGitLabAccessTokenCredentialAuditQuery(db: WorkerDb, afterId?: string) {
  return db
    .select({ parent: platform_integrations, credential: platform_access_token_credentials })
    .from(platform_access_token_credentials)
    .innerJoin(
      platform_integrations,
      eq(platform_integrations.id, platform_access_token_credentials.platform_integration_id)
    )
    .where(
      and(
        eq(platform_integrations.platform, 'gitlab'),
        ...(afterId ? [gt(platform_access_token_credentials.id, afterId)] : [])
      )
    )
    .orderBy(asc(platform_access_token_credentials.id));
}

export class DrizzleGitLabCredentialAuditStore implements GitLabCredentialAuditStore {
  constructor(private db: WorkerDb) {}

  async listCredentials(input: {
    cursor?: string;
    limit: number;
  }): Promise<GitLabCredentialAuditPage> {
    const cursor = input.cursor ? parseAuditCursor(input.cursor) : { table: 'oauth' as const };
    if (!cursor) throw new Error('Invalid GitLab credential audit cursor');

    const rows: GitLabCredentialAuditRow[] = [];
    let remaining = input.limit;
    if (cursor.table === 'oauth') {
      const oauthRows = await buildGitLabOAuthCredentialAuditQuery(this.db, cursor.afterId).limit(
        remaining + 1
      );
      if (oauthRows.length > remaining) {
        const selected = oauthRows.slice(0, remaining);
        return {
          rows: selected.map(row => ({ table: 'oauth', ...row })),
          nextCursor: encodeAuditCursor({
            table: 'oauth',
            afterId: lastCredentialId(selected),
          }),
        };
      }
      rows.push(...oauthRows.map(row => ({ table: 'oauth' as const, ...row })));
      remaining -= oauthRows.length;
      if (remaining === 0) return { rows, nextCursor: 'access-token' };
    }

    const accessTokenRows = await buildGitLabAccessTokenCredentialAuditQuery(
      this.db,
      cursor.table === 'access-token' ? cursor.afterId : undefined
    ).limit(remaining + 1);
    if (accessTokenRows.length > remaining) {
      const selected = accessTokenRows.slice(0, remaining);
      rows.push(...selected.map(row => ({ table: 'access-token' as const, ...row })));
      return {
        rows,
        nextCursor: encodeAuditCursor({
          table: 'access-token',
          afterId: lastCredentialId(selected),
        }),
      };
    }

    rows.push(...accessTokenRows.map(row => ({ table: 'access-token' as const, ...row })));
    return { rows, nextCursor: null };
  }
}

function parentOwner(parent: GitLabCredentialAuditParent): GitLabCredentialOwner | null {
  if (parent.owned_by_user_id && parent.owned_by_organization_id === null) {
    return { type: 'user', id: parent.owned_by_user_id };
  }
  if (parent.owned_by_organization_id && parent.owned_by_user_id === null) {
    return { type: 'org', id: parent.owned_by_organization_id };
  }
  return null;
}

function metadataRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parentBaseUrl(parent: GitLabCredentialAuditParent): string | null {
  const metadata = metadataRecord(parent.metadata);
  if (!metadata) return null;
  const value = metadata.gitlab_instance_url;
  if (value !== undefined && typeof value !== 'string') return null;
  return normalizeGitLabInstanceUrl(value ?? DEFAULT_GITLAB_INSTANCE_URL);
}

function oauthAuditSecrets(row: GitLabCredentialAuditRow): AuditSecret[] | null {
  const credential = GitLabOAuthCredentialRowSchema.safeParse(row.credential);
  const owner = parentOwner(row.parent);
  const providerBaseUrl = parentBaseUrl(row.parent);
  if (
    !credential.success ||
    !owner ||
    !providerBaseUrl ||
    row.parent.id !== credential.data.platform_integration_id ||
    row.parent.platform !== 'gitlab' ||
    row.parent.integration_type !== 'oauth' ||
    credential.data.provider_base_url !== providerBaseUrl ||
    credential.data.provider_subject_id !== row.parent.platform_account_id ||
    credential.data.provider_subject_login !== row.parent.platform_account_login ||
    (owner.type === 'user' && credential.data.authorized_by_user_id !== owner.id)
  ) {
    return null;
  }

  const buildSecret = (
    ciphertext: string,
    kind: 'access' | 'refresh' | 'oauth-client-secret'
  ): AuditSecret => ({
    ciphertext,
    scheme: GITLAB_OAUTH_CREDENTIAL_ENVELOPE_SCHEME,
    aad: buildGitLabOAuthCredentialAad({
      credentialId: credential.data.id,
      integrationId: credential.data.platform_integration_id,
      providerBaseUrl: credential.data.provider_base_url,
      owner,
      authorizedByUserId: credential.data.authorized_by_user_id,
      credentialVersion: credential.data.credential_version,
      kind,
    }),
  });
  const secrets = [buildSecret(credential.data.access_token_encrypted, 'access')];
  if (credential.data.refresh_token_encrypted) {
    secrets.push(buildSecret(credential.data.refresh_token_encrypted, 'refresh'));
  }
  if (credential.data.oauth_client_secret_encrypted) {
    secrets.push(buildSecret(credential.data.oauth_client_secret_encrypted, 'oauth-client-secret'));
  }
  return secrets;
}

function accessTokenAuditSecrets(row: GitLabCredentialAuditRow): AuditSecret[] | null {
  const owner = parentOwner(row.parent);
  const providerBaseUrl = parentBaseUrl(row.parent);
  if (!owner || !providerBaseUrl || row.parent.platform !== 'gitlab') return null;

  const projectCredential = GitLabProjectAccessTokenCredentialRowSchema.safeParse(row.credential);
  if (projectCredential.success) {
    const credential = projectCredential.data;
    if (
      row.parent.id !== credential.platform_integration_id ||
      credential.provider_base_url !== providerBaseUrl
    ) {
      return null;
    }
    return [
      {
        ciphertext: credential.token_encrypted,
        scheme: GITLAB_PROJECT_ACCESS_TOKEN_ENVELOPE_SCHEME,
        aad: buildGitLabProjectAccessTokenAad({
          credentialId: credential.id,
          integrationId: credential.platform_integration_id,
          providerBaseUrl: credential.provider_base_url,
          owner,
          providerResourceId: credential.provider_resource_id,
          credentialVersion: credential.credential_version,
        }),
      },
    ];
  }

  const personalCredential = GitLabPersonalAccessTokenCredentialRowSchema.safeParse(row.credential);
  if (!personalCredential.success) return null;
  const credential = personalCredential.data;
  if (
    row.parent.id !== credential.platform_integration_id ||
    row.parent.integration_type !== 'pat' ||
    credential.provider_base_url !== providerBaseUrl ||
    (owner.type === 'user' && credential.authorized_by_user_id !== owner.id)
  ) {
    return null;
  }
  return [
    {
      ciphertext: credential.token_encrypted,
      scheme: GITLAB_PERSONAL_ACCESS_TOKEN_ENVELOPE_SCHEME,
      aad: buildGitLabPersonalAccessTokenAad({
        credentialId: credential.id,
        integrationId: credential.platform_integration_id,
        providerBaseUrl: credential.provider_base_url,
        owner,
        authorizedByUserId: credential.authorized_by_user_id,
        credentialVersion: credential.credential_version,
      }),
    },
  ];
}

function auditSecretsForRow(row: GitLabCredentialAuditRow): AuditSecret[] | null {
  return row.table === 'oauth' ? oauthAuditSecrets(row) : accessTokenAuditSecrets(row);
}

export class GitLabCredentialAuditService {
  constructor(
    private store: GitLabCredentialAuditStore,
    private crypto: Pick<GitLabCredentialCrypto, 'auditDecrypt' | 'auditKeyIdentity'>
  ) {}

  async audit(input: GitLabCredentialAuditRequest) {
    let activeKey: { keyId: string; publicKeySha256: string } | null = null;
    try {
      const key = await this.crypto.auditKeyIdentity();
      if (key.status === 'available') {
        activeKey = { keyId: key.keyId, publicKeySha256: key.publicKeySha256 };
      }
    } catch {
      // Each credential is still classified as a configuration failure below.
    }
    const page = await this.store.listCredentials({ cursor: input.cursor, limit: input.limit });
    const failingCredentials: Record<FailureKind, AuditId[]> = {
      profile: [],
      configuration: [],
      parse: [],
      unknownKey: [],
      decryptOrAad: [],
    };
    let secrets = 0;
    let passedCredentials = 0;

    for (const row of page.rows) {
      const id = { integrationId: row.parent.id, credentialId: row.credential.id };
      const auditSecrets = auditSecretsForRow(row);
      if (!auditSecrets) {
        failingCredentials.profile.push(id);
        continue;
      }

      const failures = new Set<FailureKind>();
      for (const secret of auditSecrets) {
        secrets += 1;
        let result: Awaited<ReturnType<GitLabCredentialCrypto['auditDecrypt']>>;
        try {
          result = await this.crypto.auditDecrypt({
            ciphertext: secret.ciphertext,
            scheme: secret.scheme,
            aad: secret.aad,
          });
        } catch {
          failures.add('decryptOrAad');
          continue;
        }
        switch (result.status) {
          case 'configuration_error':
            failures.add('configuration');
            break;
          case 'invalid_envelope':
            failures.add('parse');
            break;
          case 'unknown_key':
            failures.add('unknownKey');
            break;
          case 'decrypt_failed':
            failures.add('decryptOrAad');
            break;
          case 'available':
            break;
        }
      }

      if (failures.size === 0) {
        passedCredentials += 1;
      } else {
        for (const failure of failures) failingCredentials[failure].push(id);
      }
    }

    return {
      activeKey,
      counts: {
        credentials: page.rows.length,
        secrets,
        passedCredentials,
        profileFailures: failingCredentials.profile.length,
        configurationFailures: failingCredentials.configuration.length,
        parseFailures: failingCredentials.parse.length,
        unknownKeyFailures: failingCredentials.unknownKey.length,
        decryptOrAadFailures: failingCredentials.decryptOrAad.length,
      },
      failingCredentials,
      nextCursor: page.nextCursor,
    };
  }
}
