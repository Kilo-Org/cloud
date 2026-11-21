import {
  getStructuredCredentialKind,
  type StructuredCredentialKind,
  type StructuredCredentialProblem,
  validateStructuredCredential,
} from '@kilocode/app-shared/byok-credentials';

/**
 * Bedrock's two authentication methods: one API key with its region, or an IAM
 * key pair with the same region. The web form takes either as one JSON object;
 * the phone asks for one method's fields at a time, so a credential can never
 * carry both.
 */
export type BedrockAuthMode = 'apiKey' | 'accessKeys';

/** The values a structured credential is built from, keyed by field. */
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
 * The first field this form still needs. Every field it renders is required:
 * the shapes have no optional field the reader may leave out, and Azure's
 * mappings are the one optional part, which is a list rather than a field.
 */
export function firstMissingField(
  form: CredentialForm,
  values: CredentialValues
): CredentialFieldId | null {
  for (const field of form.fields) {
    if ((values[field.id] ?? '').trim() === '') {
      return field.id;
    }
  }
  return null;
}

/**
 * A service-account private key in the shape the gateway signs with, or null
 * when the value is not one.
 *
 * The key is pasted as a whole value into a single-line field, and a paste can
 * arrive with its line breaks folded away or escaped by the JSON file it came
 * from: a downloaded key file stores the key as one JSON string, so copying the
 * value out of it yields the two characters `\` and `n` where a line break was.
 * Base64 does not need the breaks, so the wrapping is put back here. The result
 * is the same value whether the reader pasted a file, a folded copy of it, or
 * the escaped string from a downloaded key, so the gateway never receives a key
 * it cannot parse.
 *
 * This checks the PEM's shape and not its contents: the DER inside is the
 * gateway's to read, and the app has no parser for it. What it does catch is the
 * value that is not a PEM at all, which the credential shape accepts (it only
 * asks for a non-empty string) and which would otherwise be stored and fail at
 * the first request that tries to sign.
 */
function canonicalPrivateKey(value: string): string | null {
  const typed = value
    .replaceAll(String.raw`\r\n`, '\n')
    .replaceAll(String.raw`\n`, '\n')
    .trim();
  const match = /^-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*)-----END ([A-Z0-9 ]+)-----$/.exec(typed);
  if (!match) {
    return null;
  }
  const [, beginLabel, rawBody, endLabel] = match;
  if (
    beginLabel === undefined ||
    rawBody === undefined ||
    beginLabel !== endLabel ||
    !beginLabel.endsWith('PRIVATE KEY')
  ) {
    return null;
  }
  const body = rawBody.replaceAll(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body) || body.length % 4 !== 0) {
    return null;
  }
  const lines = body.match(/.{1,64}/g);
  if (!lines) {
    return null;
  }
  return [`-----BEGIN ${beginLabel}-----`, ...lines, `-----END ${beginLabel}-----`].join('\n');
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
      // `credentialProblem` refuses a key that is not a PEM, so a null here has
      // already stopped the submit; the wire value stays a string so a JSON null
      // can never reach the server.
      return {
        ...rest,
        googleCredentials: {
          clientEmail: googleCredentials.clientEmail,
          privateKey: stored ?? value('privateKey'),
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
  if (getStructuredCredentialKind(input.providerId) === 'vertex') {
    const { privateKey } = vertexCredential(input.values).googleCredentials;
    if (privateKey === null) {
      return { code: 'invalid-credential' };
    }
  }
  return validateStructuredCredential(input.providerId, credentialPayload(input));
}

/**
 * What one form's fields add up to: the credential to send, the field still
 * empty, one mapping row still half filled, or a shape the server's own check
 * refuses.
 */
export type CredentialRead =
  | { readonly tag: 'ready'; readonly credential: string }
  | { readonly tag: 'missing'; readonly field: CredentialFieldId }
  /**
   * One mapping row has one side filled. `mapping` is its 1-based position
   * among the rows the form shows, so the refusal can name the row.
   */
  | { readonly tag: 'incomplete-mapping'; readonly mapping: number }
  | { readonly tag: 'refused' };

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
  const missing = firstMissingField(input.form, input.values);
  if (missing) {
    return { tag: 'missing', field: missing };
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
  if (credentialProblem(credential)) {
    return { tag: 'refused' };
  }
  return { tag: 'ready', credential: JSON.stringify(credentialPayload(credential)) };
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
