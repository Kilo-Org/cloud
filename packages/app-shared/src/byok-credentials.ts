import * as z from 'zod';

/**
 * Which providers take a structured credential rather than one API key.
 *
 * The web BYOK form and the mobile key form both read this one table, so the
 * two surfaces offer the same providers and validate the same credential
 * shapes. The ids are the gateway's own provider ids.
 */
export type StructuredCredentialKind = 'azure' | 'bedrock' | 'vertex';

const STRUCTURED_CREDENTIAL_KINDS: Readonly<Record<string, StructuredCredentialKind>> = {
  azure: 'azure',
  bedrock: 'bedrock',
  'bedrock-byok': 'bedrock',
  vertex: 'vertex',
  'vertex-byok': 'vertex',
};

/** The JSON shape a provider's credential takes, or null for a single API key. */
export function getStructuredCredentialKind(providerId: string): StructuredCredentialKind | null {
  return STRUCTURED_CREDENTIAL_KINDS[providerId] ?? null;
}

/** AWS Bedrock's IAM key pair, which one of its two credential shapes carries. */
export const AwsCredentialsSchema = z.object({
  accessKeyId: z.string(),
  secretAccessKey: z.string(),
  region: z.string(),
});

/**
 * Bedrock takes one API key with its region, or an IAM key pair with the same
 * region — one authentication method, never both.
 */
export const BedrockCredentialsSchema = z.union([
  AwsCredentialsSchema.extend({ apiKey: z.never().optional() }),
  z.object({
    apiKey: z.string().trim().min(1),
    region: z.string().trim().min(1),
    accessKeyId: z.never().optional(),
    secretAccessKey: z.never().optional(),
  }),
]);

export type BedrockCredentials = z.infer<typeof BedrockCredentialsSchema>;

/**
 * Azure OpenAI takes its key and resource name; custom deployment names are
 * mapped from a gateway model slug to the deployment's own model id.
 */
export const AzureCredentialsSchema = z.object({
  apiKey: z.string().trim().min(1),
  resourceName: z.string().trim().min(1),
  modelMappings: z
    .array(
      z.object({
        gatewayModelSlug: z.string().trim().min(1),
        customModelId: z.string().trim().min(1),
      })
    )
    .optional(),
});

export type AzureCredentials = z.infer<typeof AzureCredentialsSchema>;

/** Google Vertex takes the project, its location, and the service account it signs with. */
export const VertexCredentialsSchema = z.object({
  project: z.string().min(1),
  location: z.string().min(1),
  googleCredentials: z.object({
    privateKey: z.string().min(1),
    clientEmail: z.string().min(1),
  }),
});

export type VertexCredentials = z.infer<typeof VertexCredentialsSchema>;

/**
 * Why a credential was refused, in terms a form can act on. The surfaces that
 * render the reason keep their own copy; this only names the refusal.
 */
export type StructuredCredentialProblem =
  /** A field the credential shape requires is absent or empty. */
  | { readonly code: 'missing-field'; readonly field: string }
  /** An Azure model mapping is missing its gateway slug or custom model id. */
  | { readonly code: 'invalid-model-mapping' }
  /** Bedrock got neither authentication method, or both. */
  | { readonly code: 'invalid-auth' }
  /** Anything else the credential shape refuses. */
  | { readonly code: 'invalid-credential' };

/** A credential that is not a JSON object at all. */
export type StructuredCredentialShapeProblem =
  | StructuredCredentialProblem
  | { readonly code: 'not-an-object' };

export type StructuredCredentialCheck =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly problem: StructuredCredentialShapeProblem;
      /** The failed parse, for a surface that renders its issues. */
      readonly error: z.ZodError | null;
    };

/**
 * The credential shape one provider's structured credential must satisfy, or
 * null for a provider that takes one API key.
 *
 * Vertex's direct provider id also accepts a service-account key file; that
 * shape is web-only, so its caller passes the wider schema itself.
 */
export function structuredCredentialSchema(providerId: string): z.ZodType | null {
  switch (getStructuredCredentialKind(providerId)) {
    case 'azure':
      return AzureCredentialsSchema;
    case 'bedrock':
      return BedrockCredentialsSchema;
    case 'vertex':
      return VertexCredentialsSchema;
    case null:
      return null;
  }
}

/** A field named by a failed credential parse, from the issue's own path. */
function missingField(path: readonly PropertyKey[]): StructuredCredentialProblem {
  return { code: 'missing-field', field: path.join('.') };
}

/**
 * Why this credential is refused, or null when the shape accepts it.
 *
 * The gateway's own builders read these shapes again when a request uses the
 * key; this check exists so a form can refuse what the server would, before a
 * round trip, and so both surfaces apply exactly the same rule.
 */
export function validateStructuredCredential(
  providerId: string,
  credential: unknown
): StructuredCredentialProblem | null {
  const check = checkStructuredCredential(providerId, credential);
  if (check.ok) {
    return null;
  }
  // A caller that hands this a non-object has a programming error, not a
  // credential to report; the shape check is the form's own business.
  return check.problem.code === 'not-an-object' ? null : check.problem;
}

/**
 * The check behind {@link validateStructuredCredential}, keeping the failed
 * parse so a surface can render the issues it names.
 */
export function checkStructuredCredential(
  providerId: string,
  credential: unknown,
  schema: z.ZodType | null = structuredCredentialSchema(providerId)
): StructuredCredentialCheck {
  const kind = getStructuredCredentialKind(providerId);
  if (!schema || kind === null) {
    return { ok: true };
  }
  if (typeof credential !== 'object' || credential === null || Array.isArray(credential)) {
    return { ok: false, problem: { code: 'not-an-object' }, error: null };
  }
  const result = schema.safeParse(credential);
  if (result.success) {
    return { ok: true };
  }
  switch (kind) {
    case 'azure': {
      const mappingIssue = result.error.issues.find(issue => issue.path[0] === 'modelMappings');
      if (mappingIssue) {
        return {
          ok: false,
          problem: { code: 'invalid-model-mapping' },
          error: result.error,
        };
      }
      const [issue] = result.error.issues;
      return {
        ok: false,
        problem: issue ? missingField(issue.path) : { code: 'invalid-credential' },
        error: result.error,
      };
    }
    case 'bedrock':
      return { ok: false, problem: { code: 'invalid-auth' }, error: result.error };
    case 'vertex': {
      const [issue] = result.error.issues;
      return {
        ok: false,
        problem: issue ? missingField(issue.path) : { code: 'invalid-credential' },
        error: result.error,
      };
    }
    default:
      return { ok: false, problem: { code: 'invalid-credential' }, error: result.error };
  }
}
