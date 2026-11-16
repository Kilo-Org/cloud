import { describe, expect, it } from 'vitest';
import { createAwsCloudformationClient } from './aws-cloudformation';
const id = 'arn:aws:cloudformation:us-east-1:123456789012:stack/customer/12345678-abcd';
const entry = (key: string, value: string) =>
  `<member><OutputKey>${key}</OutputKey><OutputValue>${value}</OutputValue></member>`;
function xml(outputs = entry('RoleArn', 'arn:aws:iam::123456789012:role/customer')) {
  return `<?xml version="1.0"?><DescribeStacksResponse xmlns="http://cloudformation.amazonaws.com/doc/2010-05-15/"><DescribeStacksResult><Stacks><member><StackName>customer</StackName><StackId>${id}</StackId><StackStatus>CREATE_COMPLETE</StackStatus><Parameters><member><ParameterKey>ControlPlaneUrl</ParameterKey><ParameterValue>https://worker.example.com/a?x=1&amp;y=2</ParameterValue></member></Parameters><Outputs>${outputs}</Outputs></member></Stacks></DescribeStacksResult><ResponseMetadata><RequestId>fixture</RequestId></ResponseMetadata></DescribeStacksResponse>`;
}
function client(response: string, inspect?: (request: Request) => void) {
  return createAwsCloudformationClient({
    region: 'us-east-1',
    credentials: {
      accessKeyId: 'ASIATEST000000000000',
      secretAccessKey: 'synthetic-secret',
      sessionToken: 'synthetic-token',
    },
    fetch: async request => {
      inspect?.(request);
      return new Response(response);
    },
  });
}
describe('scoped CloudFormation reads', () => {
  it('cancels an in-flight read when its caller deadline expires', async () => {
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    const api = createAwsCloudformationClient({
      region: 'us-east-1',
      credentials: { accessKeyId: 'ASIATEST000000000000', secretAccessKey: 'synthetic-secret' },
      fetch: async request =>
        new Promise((_resolve, reject) => {
          request.signal.addEventListener('abort', () => reject(request.signal.reason), {
            once: true,
          });
          started.resolve();
        }),
    });
    const pending = api.describeStack('customer', controller.signal);
    await started.promise;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'TransportError' });
  });

  it('requests one named stack and decodes its resources and parameters', async () => {
    let request: Request | undefined;
    const result = await client(xml(), value => {
      request = value;
    }).describeStack('customer');
    expect(result).toEqual({
      stackId: id,
      stackName: 'customer',
      status: 'CREATE_COMPLETE',
      parameters: { ControlPlaneUrl: 'https://worker.example.com/a?x=1&y=2' },
      outputs: { RoleArn: 'arn:aws:iam::123456789012:role/customer' },
    });
    if (!request) throw new Error('No request');
    expect(request.method).toBe('POST');
    expect(request.url).toBe('https://cloudformation.us-east-1.amazonaws.com/');
    expect(new URLSearchParams(await request.text()).get('StackName')).toBe('customer');
    expect(await client(xml()).describeStack(id)).toEqual(result);
  });
  it.each(['', '*', 'customer/other'])('rejects an unnamed or invalid scope %s', async value => {
    await expect(client(xml()).describeStack(value)).rejects.toThrow('Invalid AWS stack identity');
  });
  it.each([
    [
      'another stack',
      () => xml().replace('<StackName>customer</StackName>', '<StackName>other</StackName>'),
    ],
    ['duplicate output', () => xml(entry('RoleArn', 'one') + entry('RoleArn', 'two'))],
    ['DTD', () => '<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]>' + xml()],
    ['unknown entity', () => xml(entry('RoleArn', '&unsafe;'))],
    ['mismatched XML', () => xml().replace('</StackName>', '</StackId>')],
    [
      'pagination',
      () =>
        xml().replace(
          '</DescribeStacksResult>',
          '<NextToken>more</NextToken></DescribeStacksResult>'
        ),
    ],
    ['another account ARN', () => xml().replace(id, id.replace('123456789012', '999999999999'))],
  ] as const)('rejects %s response data', async (kind, body) => {
    const identity = kind === 'another account ARN' ? id : 'customer';
    await expect(client(body()).describeStack(identity)).rejects.toMatchObject({
      code: 'InvalidStackResponse',
    });
  });
  it('bounds XML nesting and response bytes', async () => {
    const nested = '<x>'.repeat(40) + 'text' + '</x>'.repeat(40);
    await expect(
      client(xml().replace('<RequestId>fixture</RequestId>', nested)).describeStack('customer')
    ).rejects.toMatchObject({ code: 'InvalidStackResponse' });
    await expect(
      client('x'.repeat(1024 * 1024 + 1)).describeStack('customer')
    ).rejects.toMatchObject({ code: 'ResponseTooLarge' });
  });
});
