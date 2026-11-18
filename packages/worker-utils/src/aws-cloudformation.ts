import { z } from 'zod';
import {
  createAwsClient,
  readAwsResponse,
  AwsRequestError,
  type AwsCredentials,
  type AwsFetch,
} from './aws-client';

type XmlNode = { name: string; text: string; children: XmlNode[] };
/** A contract violation is deterministic. Status 0 stays reserved for transport failures that may retry. */
function invalid(): never {
  throw new AwsRequestError(422, 'InvalidStackResponse');
}
function text(value: string): string {
  if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(value)) invalid();
  return value.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (_match, name: string) => {
    const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (!name.startsWith('#')) return named[name] ?? invalid();
    const code = name.startsWith('#x') ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
    if (
      !Number.isSafeInteger(code) ||
      code > 0x10ffff ||
      (code < 0x20 && ![9, 10, 13].includes(code)) ||
      (code >= 0xd800 && code <= 0xdfff) ||
      code === 0xfffe ||
      code === 0xffff
    )
      invalid();
    return String.fromCodePoint(code);
  });
}
/** Bounded AWS Query XML only. No DTDs, entities, comments, processing instructions or external references. */
function parseXml(value: string): XmlNode {
  const source = value.replace(/^\s*<\?xml\s+[^?]*\?>/, '');
  const tokens = source.match(/<[^<>]*>|[^<]+/g) ?? [];
  if (tokens.join('') !== source) invalid();
  const document: XmlNode = { name: 'document', text: '', children: [] };
  const stack = [document];
  let count = 0;
  for (const token of tokens) {
    const current = stack.at(-1);
    if (!current) invalid();
    if (!token.startsWith('<')) {
      current.text += text(token);
      continue;
    }
    const closing = /^<\/([A-Za-z][A-Za-z0-9]*)\s*>$/.exec(token);
    if (closing) {
      if (stack.length < 2 || current.name !== closing[1]) invalid();
      stack.pop();
      continue;
    }
    const opening =
      /^<([A-Za-z][A-Za-z0-9]*)(\s+xmlns="http:\/\/cloudformation\.amazonaws\.com\/doc\/2010-05-15\/"\s*)?\s*(\/?)>$/.exec(
        token
      );
    if (!opening || ++count > 10_000 || stack.length >= 32 || (opening[2] && stack.length !== 1))
      invalid();
    const node: XmlNode = { name: opening[1], text: '', children: [] };
    current.children.push(node);
    if (!opening[3]) stack.push(node);
  }
  if (stack.length !== 1 || document.text.trim() || document.children.length !== 1) invalid();
  const root = document.children[0];
  if (root.name !== 'DescribeStacksResponse') invalid();
  return root;
}
function child(node: XmlNode, name: string): XmlNode | undefined {
  const found = node.children.filter(value => value.name === name);
  if (found.length > 1) invalid();
  return found[0];
}
function required(node: XmlNode, name: string): XmlNode {
  return child(node, name) ?? invalid();
}
function scalar(node: XmlNode, name: string): string {
  const value = required(node, name);
  if (value.children.length || value.text.length > 16_384) invalid();
  return value.text;
}
function members(node: XmlNode, name: string, key: string, value: string): Record<string, string> {
  const container = child(node, name);
  if (!container) return {};
  const entries: Array<[string, string]> = [];
  const keys = new Set<string>();
  for (const member of container.children) {
    if (member.name !== 'member') invalid();
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
      const root = parseXml(await readAwsResponse(response, 1024 * 1024));
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
