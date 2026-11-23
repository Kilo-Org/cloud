import {
  getStructuredCredentialKind,
  type StructuredCredentialKind,
  type StructuredCredentialProblem,
  validateStructuredCredential,
} from '@kilocode/app-shared/byok-credentials';

import { canonicalPrivateKey, type PrivateKeyCause } from './private-key';

/**
 * Bedrock's two authentication methods: one API key with its region, or an IAM
 * key pair with the same region. The web form takes either as one JSON object;
 * the phone asks for one method's fields at a time, so a credential can never
 * carry both.
 */
export type BedrockAuthMode = 'apiKey' | 'accessKeys';

export type CredentialFieldId =
  | 'apiKey'
  | 'resourceName'
  | 'region'
  | 'accessKeyId'
  | 'secretAccessKey'
  | 'project'
  | 'location'
  | 'clientEmail'
  | 'privateKey';

/** The values typed into one form, keyed by the credential's own field. */
export type CredentialDraft = Partial<Record<CredentialFieldId, string>>;

export type CredentialValues = Readonly<CredentialDraft>;

/** One Azure custom deployment: a gateway model slug served by a deployment id. */
export type ModelMapping = Readonly<{ gatewayModelSlug: string; customModelId: string }>;

type CredentialField = Readonly<{
  id: CredentialFieldId;
  /**
   * The value is a secret. It is masked while it is typed, on both platforms,
   * which is why no credential field is multiline: React Native masks a
   * single-line input and cannot mask a multiline one. Its keyboard still
   * suggests nothing and learns nothing.
   */
  secret: boolean;
  /** The copy that names this field on the form. */
  labelKey: string;
}>;

export type CredentialForm = Readonly<{
  kind: StructuredCredentialKind;
  fields: readonly CredentialField[];
  /** Bedrock chooses its authentication method before either field set. */
  showsAuthMode: boolean;
  /** Azure may map a gateway model slug to a custom deployment name. */
  showsModelMappings: boolean;
}>;

const API_KEY_FIELD: CredentialField = {
  id: 'apiKey',
  secret: true,
  labelKey: 'profile.providerKeys.apiKeyLabel',
};

const REGION_FIELD: CredentialField = {
  id: 'region',
  secret: false,
  labelKey: 'profile.providerKeys.region',
};

const AZURE_FORM: CredentialForm = {
  kind: 'azure',
  fields: [
    API_KEY_FIELD,
    {
      id: 'resourceName',
      secret: false,
      labelKey: 'profile.providerKeys.resourceName',
    },
  ],
  showsAuthMode: false,
  showsModelMappings: true,
};

const BEDROCK_FORMS = {
  apiKey: {
    kind: 'bedrock',
    fields: [API_KEY_FIELD, REGION_FIELD],
    showsAuthMode: true,
    showsModelMappings: false,
  },
  accessKeys: {
    kind: 'bedrock',
    fields: [
      {
        id: 'accessKeyId',
        secret: false,
        labelKey: 'profile.providerKeys.accessKeyId',
      },
      {
        id: 'secretAccessKey',
        secret: true,
        labelKey: 'profile.providerKeys.secretAccessKey',
      },
      REGION_FIELD,
    ],
    showsAuthMode: true,
    showsModelMappings: false,
  },
} satisfies Record<BedrockAuthMode, CredentialForm>;

const VERTEX_FORM: CredentialForm = {
  kind: 'vertex',
  fields: [
    {
      id: 'project',
      secret: false,
      labelKey: 'profile.providerKeys.project',
    },
    {
      id: 'location',
      secret: false,
      labelKey: 'profile.providerKeys.location',
    },
    {
      id: 'clientEmail',
      secret: false,
      labelKey: 'profile.providerKeys.clientEmail',
    },
    {
      id: 'privateKey',
      secret: true,
      labelKey: 'profile.providerKeys.privateKey',
    },
  ],
  showsAuthMode: false,
  showsModelMappings: false,
};

/**
 * The fields a structured credential for this provider takes, or null for a
 * provider whose key is one value.
 */
export function credentialForm(providerId: string, mode: BedrockAuthMode): CredentialForm | null {
  switch (getStructuredCredentialKind(providerId)) {
    case 'azure': {
      return AZURE_FORM;
    }
    case 'bedrock': {
      return BEDROCK_FORMS[mode];
    }
    case 'vertex': {
      return VERTEX_FORM;
    }
    case null: {
      return null;
    }
    default: {
      return null;
    }
  }
}

/**
 * The copy key that names one field on this form. A field the form does not
 * show falls back to the API-key label, the same field the one-value form has.
 */
export function fieldLabelKey(form: CredentialForm, id: CredentialFieldId): string {
  return form.fields.find(field => field.id === id)?.labelKey ?? 'profile.providerKeys.apiKeyLabel';
}

/**
 * Whether replacing this key reads the method its saved credential used: only
 * the edit route of a Bedrock key has one. A new key has none yet, and a
 * one-value provider has no method at all.
 */
export function replacesBedrockKey(
  providerId: string | undefined,
  keyId: string | undefined
): boolean {
  return (
    keyId !== undefined &&
    providerId !== undefined &&
    credentialForm(providerId, 'apiKey')?.kind === 'bedrock'
  );
}

/**
 * Every field this form still needs, in the order the form shows them, so each
 * empty field gets its own message rather than only the first one. Every field
 * it renders is required: the shapes have no optional field the reader may
 * leave out, and Azure's mappings are the one optional part, which is a list
 * rather than a field.
 */
export function missingFields(form: CredentialForm, values: CredentialValues): CredentialFieldId[] {
  return form.fields.filter(field => (values[field.id] ?? '').trim() === '').map(field => field.id);
}

/** The Vertex credential one form's fields add up to, with its key in canonical form. */
function vertexCredential(values: CredentialValues) {
  return {
    project: (values.project ?? '').trim(),
    location: (values.location ?? '').trim(),
    googleCredentials: {
      clientEmail: (values.clientEmail ?? '').trim(),
      privateKey: canonicalPrivateKey(values.privateKey ?? ''),
    },
  };
}

/** The credential's own JSON object, without the empty mappings list. */
export function credentialPayload(input: {
  providerId: string;
  mode: BedrockAuthMode;
  values: CredentialValues;
  modelMappings: readonly ModelMapping[];
}) {
  const value = (id: CredentialFieldId) => (input.values[id] ?? '').trim();
  switch (getStructuredCredentialKind(input.providerId)) {
    case 'azure': {
      return {
        apiKey: value('apiKey'),
        resourceName: value('resourceName'),
        ...(input.modelMappings.length > 0 ? { modelMappings: input.modelMappings } : {}),
      };
    }
    case 'bedrock': {
      return input.mode === 'apiKey'
        ? { apiKey: value('apiKey'), region: value('region') }
        : {
            accessKeyId: value('accessKeyId'),
            secretAccessKey: value('secretAccessKey'),
            region: value('region'),
          };
    }
    case 'vertex': {
      const { googleCredentials, ...rest } = vertexCredential(input.values);
      const stored = googleCredentials.privateKey;
      // `credentialProblem` refuses a key the gateway cannot sign with, so a
      // refused read here has already stopped the submit; the wire value stays
      // a string so a JSON null can never reach the server.
      return {
        ...rest,
        googleCredentials: {
          clientEmail: googleCredentials.clientEmail,
          privateKey: stored.tag === 'key' ? stored.pem : value('privateKey'),
        },
      };
    }
    case null: {
      return {};
    }
    default: {
      return {};
    }
  }
}

/**
 * Why the Vertex private key the fields hold is not one the gateway can sign
 * with, or null when it is. It is the one refusal here about a single field's
 * value rather than about the credential the fields add up to, so the form
 * points at the field instead of at the whole form, and names its cause.
 */
function privateKeyRefusal(providerId: string, values: CredentialValues): PrivateKeyCause | null {
  if (getStructuredCredentialKind(providerId) !== 'vertex') {
    return null;
  }
  const key = vertexCredential(values).googleCredentials.privateKey;
  return key.tag === 'key' ? null : key.cause;
}

/**
 * Why this credential is refused, by the same check the web BYOK form runs on
 * the JSON it accepts, plus the one rule that shape cannot express: the Vertex
 * private key must be a PEM the gateway can sign with. The form's own
 * required-field check answers its fields; this answers the value they add up to.
 */
export function credentialProblem(input: {
  providerId: string;
  mode: BedrockAuthMode;
  values: CredentialValues;
  modelMappings: readonly ModelMapping[];
}): StructuredCredentialProblem | null {
  if (privateKeyRefusal(input.providerId, input.values) !== null) {
    return { code: 'invalid-credential' };
  }
  return validateStructuredCredential(input.providerId, credentialPayload(input));
}

/**
 * What one form's fields add up to: the credential to send, the fields still
 * empty, one mapping row still half filled, or a shape the server's own check
 * refuses.
 */
export type CredentialRead =
  | { readonly tag: 'ready'; readonly credential: string }
  /** Every field still empty, in the order the form shows them. */
  | { readonly tag: 'missing'; readonly fields: readonly CredentialFieldId[] }
  /**
   * One mapping row has one side filled. `mapping` is its 1-based position
   * among the rows the form shows, so the refusal can name the row.
   */
  | { readonly tag: 'incomplete-mapping'; readonly mapping: number }
  /**
   * The credential's shape is refused. `field` names the one field whose own
   * value the check refuses, when the refusal is about that value rather than
   * about the fields together: the field is masked, so a form-wide sentence
   * would leave the reader with no value to look at and fix. `cause` names why
   * that value is refused, when the refusal has more than one reason; a field
   * whose value is refused for one reason carries no cause.
   */
  | {
      readonly tag: 'refused';
      readonly field?: CredentialFieldId;
      readonly cause?: PrivateKeyCause;
    };

/**
 * The credential a structured form holds. `rows` are Azure's mapping rows as
 * typed, in the order the form shows them; a row with neither side filled asks
 * for nothing.
 */
export function readStructuredCredential(input: {
  providerId: string;
  mode: BedrockAuthMode;
  form: CredentialForm;
  values: CredentialValues;
  rows: readonly Partial<ModelMapping>[];
}): CredentialRead {
  const missing = missingFields(input.form, input.values);
  if (missing.length > 0) {
    return { tag: 'missing', fields: missing };
  }
  const modelMappings: ModelMapping[] = [];
  for (const [index, row] of input.rows.entries()) {
    const gatewayModelSlug = (row.gatewayModelSlug ?? '').trim();
    const customModelId = (row.customModelId ?? '').trim();
    if (gatewayModelSlug !== '' || customModelId !== '') {
      if (gatewayModelSlug === '' || customModelId === '') {
        return { tag: 'incomplete-mapping', mapping: index + 1 };
      }
      modelMappings.push({ gatewayModelSlug, customModelId });
    }
  }
  const credential = {
    providerId: input.providerId,
    mode: input.mode,
    values: input.values,
    modelMappings,
  };
  const keyRefusal = privateKeyRefusal(input.providerId, input.values);
  if (credentialProblem(credential)) {
    return keyRefusal === null
      ? { tag: 'refused' }
      : { tag: 'refused', field: 'privateKey', cause: keyRefusal };
  }
  return { tag: 'ready', credential: JSON.stringify(credentialPayload(credential)) };
}

/**
 * The credential a screen's form holds: one value for a provider whose key is a
 * single secret, or the JSON the structured form's fields add up to.
 */
export function readCredential(input: {
  providerId: string;
  form: CredentialForm | null;
  mode: BedrockAuthMode;
  apiKey: string;
  values: CredentialValues;
  rows: readonly Partial<ModelMapping>[];
}): CredentialRead {
  if (input.form) {
    return readStructuredCredential({
      providerId: input.providerId,
      mode: input.mode,
      form: input.form,
      values: input.values,
      rows: input.rows,
    });
  }
  const apiKey = input.apiKey.trim();
  return apiKey === ''
    ? { tag: 'missing', fields: ['apiKey'] }
    : { tag: 'ready', credential: apiKey };
}

/**
 * The draft with only the values this form renders. Bedrock's two methods share
 * the draft, and a field the next method does not show comes back empty, so
 * keeping its value would send what the reader cannot see.
 */
export function withoutUnshownValues(form: CredentialForm | null, values: CredentialValues) {
  const kept: CredentialDraft = {};
  for (const field of form?.fields ?? []) {
    const value = values[field.id];
    if (value !== undefined) {
      kept[field.id] = value;
    }
  }
  return kept;
}
