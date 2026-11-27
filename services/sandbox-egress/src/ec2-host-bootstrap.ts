import { z } from 'zod';
import {
  awsCredentialsSchema,
  AwsRequestError,
  createAwsClient,
  readAwsResponse,
  type AwsFetch,
} from '@kilocode/worker-utils/aws-client';
import { awsBucketSchema, awsRegionSchema } from '@kilocode/worker-utils/aws-byoc';
import {
  awsEc2AccountIdSchema,
  awsEc2InstanceIdSchema,
  AWS_EC2_TAGS,
} from '@kilocode/worker-utils/aws-ec2';
import { awsEc2HostLaunchSchema } from '@kilocode/worker-utils/aws-egress';
import { parseEgressCredential } from './control-plane.js';

const METADATA_ORIGIN = 'http://169.254.169.254';
const DOCUMENT_LIMIT = 262_144;
const metadataSchema = z.object({
  accountId: awsEc2AccountIdSchema,
  region: awsRegionSchema,
  instanceId: awsEc2InstanceIdSchema,
});
const launchSchema = z
  .object({
    format: z.literal(1),
    deadlineAt: z.number().int().positive(),
    argv: z
      .array(z.string().refine(value => !value.includes('\0')))
      .min(1)
      .max(64),
    env: z.record(
      z.string().regex(/^[A-Za-z_][A-Za-z_0-9]*$/),
      z.string().refine(value => !value.includes('\0'))
    ),
    host: awsEc2HostLaunchSchema,
  })
  .strict();

export function createEc2BootSource(input: { region: string; bucket: string; fetch: AwsFetch }) {
  const region = awsRegionSchema.parse(input.region);
  const bucket = awsBucketSchema.parse(input.bucket);
  async function metadata(path: string, token?: string, absent = false) {
    const response = await input.fetch(
      new Request(METADATA_ORIGIN + path, {
        method: token ? 'GET' : 'PUT',
        headers: token
          ? { 'x-aws-ec2-metadata-token': token }
          : { 'x-aws-ec2-metadata-token-ttl-seconds': '60' },
        redirect: 'error',
        signal: AbortSignal.timeout(2_000),
      })
    );
    if (absent && response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('EC2 metadata unavailable');
    }
    return readAwsResponse(response, 32_768);
  }

  async function currentInstance(now: number, seen?: string) {
    const token = await metadata('/latest/api/token');
    if (!token || token.length > 4096) throw new Error('EC2 metadata token unavailable');
    const hint = await metadata(
      '/latest/meta-data/tags/instance/' + AWS_EC2_TAGS.allocation,
      token,
      true
    );
    if (hint === null) return null;
    const allocationId = z.uuid().parse(hint);
    if (allocationId === seen) return null;

    const [rawIdentity, rawRole, generationHint] = await Promise.all([
      metadata('/latest/dynamic/instance-identity/document', token),
      metadata('/latest/meta-data/iam/security-credentials/', token),
      metadata('/latest/meta-data/tags/instance/' + AWS_EC2_TAGS.generation, token),
    ]);
    const instance = metadataSchema.parse(JSON.parse(rawIdentity ?? ''));
    const generation = z.uuid().parse(generationHint);
    const role = z
      .string()
      .regex(/^[A-Za-z0-9+=,.@_-]{1,128}$/)
      .parse(rawRole?.trim());
    if (instance.region !== region) throw new Error('EC2 boot region mismatch');
    const roleGrant = z
      .object({
        Code: z.literal('Success'),
        AccessKeyId: z.string(),
        SecretAccessKey: z.string(),
        Token: z.string(),
        Expiration: z.iso.datetime(),
      })
      .parse(
        JSON.parse(
          (await metadata('/latest/meta-data/iam/security-credentials/' + role, token)) ?? ''
        )
      );
    const credentials = awsCredentialsSchema.parse({
      accessKeyId: roleGrant.AccessKeyId,
      secretAccessKey: roleGrant.SecretAccessKey,
      sessionToken: roleGrant.Token,
      expiresAt: Date.parse(roleGrant.Expiration),
    });
    if ((credentials.expiresAt ?? 0) <= now) throw new Error('EC2 boot role expired');
    const client = createAwsClient({ region, service: 's3', credentials, fetch: input.fetch });
    const instanceArn = `arn:aws:ec2:${region}:${instance.accountId}:instance/${instance.instanceId}`;
    return { instance, generation, allocationId, client, instanceArn };
  }

  return {
    async readLaunch(seen?: string, now = Date.now()) {
      const current = await currentInstance(now, seen);
      if (!current) return null;
      const { instance, generation, allocationId, client, instanceArn } = current;
      const url = `https://${bucket}.s3.${region}.amazonaws.com/kilo/launch/${instanceArn}/${allocationId}.json`;
      let document;
      try {
        document = launchSchema.parse(
          JSON.parse(await readAwsResponse(await client.request(url), DOCUMENT_LIMIT))
        );
      } catch (error) {
        if (error instanceof AwsRequestError && [403, 404].includes(error.status)) return null;
        throw error;
      }
      const { host, ...workload } = document;
      const claims = parseEgressCredential(host.token);
      if (
        host.instanceId !== instance.instanceId ||
        host.allocationId !== allocationId ||
        host.identity.generation !== generation ||
        host.identity.stackId.split(':')[4] !== instance.accountId ||
        workload.deadlineAt <= now ||
        workload.deadlineAt > now + 15 * 60_000 ||
        host.expiresAt <= workload.deadlineAt ||
        claims?.type !== 'aws_ec2_egress' ||
        claims.exp * 1000 !== host.expiresAt ||
        claims.sandboxId !== host.sandboxId ||
        !workload.argv[0]
      )
        throw new Error('EC2 boot binding mismatch');
      return { host, workload };
    },
    async attestCleanStop(host: z.infer<typeof awsEc2HostLaunchSchema>) {
      const current = await currentInstance(Date.now());
      if (
        !current ||
        current.instance.instanceId !== host.instanceId ||
        current.allocationId !== host.allocationId ||
        current.generation !== host.identity.generation
      )
        throw new Error('EC2 stop binding mismatch');
      const url = `https://${bucket}.s3.${region}.amazonaws.com/kilo/stopped/${current.instanceArn}/${current.allocationId}.json`;
      try {
        const response = await current.client.request(url, {
          method: 'PUT',
          headers: { 'content-type': 'application/json', 'if-none-match': '*' },
          body: '{}',
          signal: AbortSignal.timeout(5000),
        });
        await response.body?.cancel();
      } catch (error) {
        if (!(error instanceof AwsRequestError) || error.status !== 412) throw error;
      }
    },
  };
}
