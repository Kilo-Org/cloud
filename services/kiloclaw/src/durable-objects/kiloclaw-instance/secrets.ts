import type {
  EncryptedEnvelope,
  CustomSecretMeta,
  PersistedState,
} from '../../schemas/instance-config';
import {
  SECRET_CATALOG,
  FIELD_KEY_TO_ENV_VAR,
  ENV_VAR_TO_FIELD_KEY,
  ALL_SECRET_FIELD_KEYS,
  MAX_CUSTOM_SECRETS,
  type SecretFieldKey,
} from '@kilocode/kiloclaw-secret-catalog';

export type SecretsRuntime = {
  state: SecretsMutableState;
  persist: (patch: Partial<PersistedState>) => Promise<void>;
};

export type SecretsMutableState = {
  channels: PersistedState['channels'];
  encryptedSecrets: PersistedState['encryptedSecrets'];
  customSecretMeta: PersistedState['customSecretMeta'];
};

export async function updateSecrets(
  runtime: SecretsRuntime,
  patch: Record<string, EncryptedEnvelope | null>,
  meta?: Record<string, CustomSecretMeta>
): Promise<{ configured: SecretFieldKey[] }> {
  const { state, persist } = runtime;

  const currentSecrets: Record<string, EncryptedEnvelope | null> = {
    ...(state.channels ?? {}),
  };
  const customSecrets: Record<string, EncryptedEnvelope> = {};
  if (state.encryptedSecrets) {
    for (const [key, value] of Object.entries(state.encryptedSecrets)) {
      const fieldKey = ENV_VAR_TO_FIELD_KEY.get(key);
      if (fieldKey) {
        currentSecrets[fieldKey] = value;
      } else {
        customSecrets[key] = value;
      }
    }
  }

  for (const [key, value] of Object.entries(patch)) {
    const isCatalogKey = ALL_SECRET_FIELD_KEYS.has(key);
    if (value === null) {
      console.log('[DO] Secret removed', { key, operation: 'remove' });
      if (isCatalogKey) {
        delete currentSecrets[key];
      } else {
        delete customSecrets[key];
      }
    } else {
      console.log('[DO] Secret updated', { key, operation: 'set' });
      if (isCatalogKey) {
        currentSecrets[key] = value;
      } else {
        customSecrets[key] = value;
      }
    }
  }

  for (const entry of SECRET_CATALOG) {
    if (!entry.allFieldsRequired) continue;
    const fieldValues = entry.fields.map(f => currentSecrets[f.key]);
    const hasAny = fieldValues.some(v => v != null);
    const hasAll = fieldValues.every(v => v != null);
    if (hasAny && !hasAll) {
      const err = new Error(
        `Invalid secret patch: ${entry.label} requires all fields to be set together`
      );
      (err as Error & { status: number }).status = 400;
      throw err;
    }
  }

  const customCount = Object.keys(customSecrets).length;
  if (customCount > MAX_CUSTOM_SECRETS) {
    const err = new Error(
      `Custom secret limit exceeded: ${customCount} secrets (max ${MAX_CUSTOM_SECRETS})`
    );
    (err as Error & { status: number }).status = 400;
    throw err;
  }

  const channelKeys = new Set(
    SECRET_CATALOG.filter(e => e.category === 'channel').flatMap(e => e.fields.map(f => f.key))
  );
  const channelsSubset: Record<string, EncryptedEnvelope> = {};
  for (const [key, value] of Object.entries(currentSecrets)) {
    if (channelKeys.has(key) && value) {
      channelsSubset[key] = value;
    }
  }

  const hasChannels = Object.keys(channelsSubset).length > 0;
  state.channels = hasChannels ? (channelsSubset as PersistedState['channels']) : null;

  const cleanedSecrets: Record<string, EncryptedEnvelope> = {};
  for (const [key, value] of Object.entries(currentSecrets)) {
    if (value) {
      cleanedSecrets[key] = value;
    }
  }

  const configured = Object.keys(cleanedSecrets).filter((k): k is SecretFieldKey =>
    ALL_SECRET_FIELD_KEYS.has(k)
  );

  const remappedSecrets: Record<string, EncryptedEnvelope> = { ...customSecrets };
  for (const [key, value] of Object.entries(cleanedSecrets)) {
    const envName = FIELD_KEY_TO_ENV_VAR.get(key) ?? key;
    remappedSecrets[envName] = value;
  }
  const hasSecrets = Object.keys(remappedSecrets).length > 0;
  state.encryptedSecrets = hasSecrets ? remappedSecrets : null;

  const currentMeta = { ...(state.customSecretMeta ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (ALL_SECRET_FIELD_KEYS.has(key)) continue;
    if (value === null) {
      delete currentMeta[key];
    }
  }
  if (meta) {
    for (const [key, metaValue] of Object.entries(meta)) {
      if (ALL_SECRET_FIELD_KEYS.has(key)) continue;
      if (metaValue.configPath) {
        for (const [existingKey, existingMeta] of Object.entries(currentMeta)) {
          if (existingKey !== key && existingMeta.configPath === metaValue.configPath) {
            const err = new Error(
              `Config path "${metaValue.configPath}" is already used by secret "${existingKey}"`
            );
            (err as Error & { status: number }).status = 400;
            throw err;
          }
        }
      }
      currentMeta[key] = metaValue;
    }
  }
  const hasMeta = Object.keys(currentMeta).length > 0;
  state.customSecretMeta = hasMeta ? currentMeta : null;

  await persist({
    channels: state.channels,
    encryptedSecrets: state.encryptedSecrets,
    customSecretMeta: state.customSecretMeta,
  });

  return { configured };
}

export async function updateChannels(
  runtime: SecretsRuntime,
  patch: {
    telegramBotToken?: EncryptedEnvelope | null;
    discordBotToken?: EncryptedEnvelope | null;
    slackBotToken?: EncryptedEnvelope | null;
    slackAppToken?: EncryptedEnvelope | null;
  }
): Promise<{ configured: SecretFieldKey[] }> {
  const secretsPatch: Record<string, EncryptedEnvelope | null> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) {
      secretsPatch[key] = value;
    }
  }
  return updateSecrets(runtime, secretsPatch);
}
