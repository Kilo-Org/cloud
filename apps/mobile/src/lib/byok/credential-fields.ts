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
   * The value is a secret. A single-line one is masked while it is typed; the
   * form still asks the keyboard to suggest nothing and learn nothing from
   * either kind.
   */
  secret: boolean;
  /**
   * The value needs more than one line. A PEM private key is the only one. The
   * field is still marked secret: Android masks a multiline secure input, and
   * where a platform cannot mask it the value stays readable but the field
   * still asks the keyboard to suggest nothing and learn nothing.
   */
  multiline: boolean;
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
  multiline: false,
  labelKey: 'profile.providerKeys.apiKeyLabel',
};

const REGION_FIELD: CredentialField = {
  id: 'region',
  secret: false,
  multiline: false,
  labelKey: 'profile.providerKeys.region',
};

const AZURE_FORM: CredentialForm = {
  kind: 'azure',
  fields: [
    API_KEY_FIELD,
    {
      id: 'resourceName',
      secret: false,
      multiline: false,
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
        multiline: false,
        labelKey: 'profile.providerKeys.accessKeyId',
      },
      {
        id: 'secretAccessKey',
        secret: true,
        multiline: false,
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
      multiline: false,
      labelKey: 'profile.providerKeys.project',
    },
    {
      id: 'location',
      secret: false,
      multiline: false,
      labelKey: 'profile.providerKeys.location',
    },
    {
      id: 'clientEmail',
      secret: false,
      multiline: false,
      labelKey: 'profile.providerKeys.clientEmail',
    },
    {
      id: 'privateKey',
      secret: true,
      multiline: true,
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
      return {
        project: value('project'),
        location: value('location'),
        googleCredentials: {
          clientEmail: value('clientEmail'),
          privateKey: (input.values.privateKey ?? '').trim(),
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
 * the JSON it accepts. The form's own required-field check answers its fields;
 * this answers the shape they add up to.
 */
export function credentialProblem(input: {
  providerId: string;
  mode: BedrockAuthMode;
  values: CredentialValues;
  modelMappings: readonly ModelMapping[];
}): StructuredCredentialProblem | null {
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
