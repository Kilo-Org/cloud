import { z } from 'zod';
import {
  createAwsClient,
  readAwsResponse,
  AwsRequestError,
  type AwsCredentials,
  type AwsFetch,
} from './aws-client';
import { createAwsQueryXmlReader } from './aws-query-xml';

// A contract violation is deterministic. Status 0 is reserved for transport failures.
function invalid(): never {
  throw new AwsRequestError(422, 'InvalidStackResponse');
}
const xml = createAwsQueryXmlReader('http://cloudformation.amazonaws.com/doc/2010-05-15/', invalid);
const { child, required, scalar } = xml;

function members(
  node: ReturnType<typeof xml.parse>,
  name: string,
  key: string,
  value: string
): Record<string, string> {
  const entries: Array<[string, string]> = [];
  const keys = new Set<string>();
  for (const member of xml.items(node, name, 'member')) {
    const name = scalar(member, key);
    if (!name || keys.has(name)) invalid();
    keys.add(name);
    entries.push([name, scalar(member, value)]);
  }
  return Object.fromEntries(entries);
}
const stackArn = z
  .string()
  .regex(
    /^arn:aws:cloudformation:([a-z]{2}-[a-z]+-\d):\d{12}:stack\/[A-Za-z][A-Za-z0-9-]{0,127}\/[a-f0-9-]+$/
  );
const stackName = z.string().regex(/^[A-Za-z][A-Za-z0-9-]{0,127}$/);
export type AwsStack = {
  stackId: string;
  stackName: string;
  status: string;
  parameters: Record<string, string>;
  outputs: Record<string, string>;
};

/** Always name one stack. Customer roles need no account-wide stack discovery permission. */
export function createAwsCloudformationClient(input: {
  credentials: AwsCredentials;
  region: string;
  fetch?: AwsFetch;
}) {
  const client = createAwsClient({ ...input, service: 'cloudformation' });
  return {
    async describeStack(identity: string, signal?: AbortSignal): Promise<AwsStack> {
      if (!stackName.safeParse(identity).success && !stackArn.safeParse(identity).success)
        throw new Error('Invalid AWS stack identity');
      const body = new URLSearchParams({
        Action: 'DescribeStacks',
        Version: '2010-05-15',
        StackName: identity,
      });
      const response = await client.request(
        `https://cloudformation.${input.region}.amazonaws.com/`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
          signal,
        }
      );
      const root = xml.parse(
        await readAwsResponse(response, 1024 * 1024),
        'DescribeStacksResponse'
      );
      const result = required(root, 'DescribeStacksResult');
      if (child(result, 'NextToken')) invalid();
      const stacks = required(result, 'Stacks');
      if (stacks.children.length !== 1 || stacks.children[0].name !== 'member') invalid();
      const record = stacks.children[0];
      const id = scalar(record, 'StackId');
      const name = scalar(record, 'StackName');
      if (
        !stackArn.safeParse(id).success ||
        !stackName.safeParse(name).success ||
        id.split(':')[3] !== input.region ||
        !id.includes(`:stack/${name}/`) ||
        (identity.startsWith('arn:') ? identity !== id : identity !== name)
      )
        invalid();
      return {
        stackId: id,
        stackName: name,
        status: scalar(record, 'StackStatus'),
        parameters: members(record, 'Parameters', 'ParameterKey', 'ParameterValue'),
        outputs: members(record, 'Outputs', 'OutputKey', 'OutputValue'),
      };
    },
  };
}
