import { z } from 'zod';
import {
  AwsRequestError,
  createAwsClient,
  readAwsResponse,
  type AwsCredentials,
  type AwsFetch,
} from '@kilocode/worker-utils/aws-client';

export const microvmRunRequestSchema = z
  .object({
    clientToken: z.string().min(1).max(128),
    imageIdentifier: z
      .string()
      .regex(/^arn:aws:lambda:[a-z0-9-]+:\d{12}:microvm-image:[A-Za-z0-9_-]+$/),
    imageVersion: z.string().regex(/^\d+\.\d+$/),
    ingressNetworkConnectors: z.tuple([z.string().endsWith(':NO_INGRESS')]),
    egressNetworkConnectors: z.tuple([z.string().min(1)]),
    logging: z.object({ disabled: z.object({}).strict() }).strict(),
    maximumDurationInSeconds: z.number().int().min(1).max(28_800),
    runHookPayload: z.string().max(16_384),
  })
  .strict();

export type MicrovmRunRequest = z.infer<typeof microvmRunRequestSchema>;

export const microvmSchema = z.object({
  microvmId: z.string().regex(/^microvm-[a-z0-9-]+$/),
  imageArn: z.string(),
  imageVersion: z.string(),
  state: z.enum(['PENDING', 'RUNNING', 'SUSPENDING', 'SUSPENDED', 'TERMINATING', 'TERMINATED']),
  startedAt: z.number().optional(),
  maximumDurationInSeconds: z.number().int(),
  ingressNetworkConnectors: z.array(z.string()),
  egressNetworkConnectors: z.array(z.string()),
  executionRoleArn: z.string().nullable().optional(),
  idlePolicy: z
    .object({
      autoResumeEnabled: z.boolean(),
      maxIdleDurationSeconds: z.number(),
      suspendedDurationSeconds: z.number(),
    })
    .nullable()
    .optional(),
});

/** The Run endpoint refused this submission before allocating compute. */
export class AwsMicrovmRunRejectedError extends AwsRequestError {}

export type Microvm = z.infer<typeof microvmSchema>;
export type MicrovmClient = {
  run(request: MicrovmRunRequest): Promise<Microvm>;
  get(id: string): Promise<Microvm>;
  terminate(id: string): Promise<void>;
};

/** No execution role, ingress authentication, shell, suspend or image mutation authority. */
export function createMicrovmClient(input: {
  credentials: AwsCredentials;
  region: string;
  fetch?: AwsFetch;
}): MicrovmClient {
  const client = createAwsClient({ ...input, service: 'lambda' });
  const base = `https://lambda.${input.region}.amazonaws.com/2025-09-09/microvms`;
  function resource(id: string): string {
    if (!/^microvm-[a-z0-9-]+$/.test(id)) throw new Error('Invalid MicroVM identity');
    return `${base}/${encodeURIComponent(id)}`;
  }
  async function read(response: Response): Promise<Microvm> {
    const body = await readAwsResponse(response);
    let input: unknown;
    try {
      input = JSON.parse(body);
    } catch {
      throw new Error('Invalid AWS MicroVM response');
    }
    const parsed = microvmSchema.safeParse(input);
    if (!parsed.success) throw new Error('Invalid AWS MicroVM response');
    return parsed.data;
  }
  return {
    async run(request) {
      const body = JSON.stringify(microvmRunRequestSchema.parse(request));
      let response: Response;
      try {
        response = await client.request(base, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        });
      } catch (error) {
        if (
          error instanceof AwsRequestError &&
          (error.status === 403 ||
            (error.status === 400 &&
              ['AccessDeniedException', 'ValidationException'].includes(error.code)))
        )
          throw new AwsMicrovmRunRejectedError(error.status, error.code);
        throw error;
      }
      return read(response);
    },
    async get(id) {
      return read(await client.request(resource(id)));
    },
    async terminate(id) {
      const response = await client.request(resource(id), { method: 'DELETE' });
      await response.body?.cancel();
    },
  };
}
