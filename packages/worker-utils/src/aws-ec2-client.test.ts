import { describe, expect, it } from 'vitest';
import { assertAwsEc2Instance, createAwsEc2Client } from './aws-ec2-client';
import { AWS_EC2_TAGS, awsEc2ByocConfigurationSchema } from './aws-ec2';

const config = awsEc2ByocConfigurationSchema.parse({
  region: 'us-east-1',
  roleArn: 'arn:aws:iam::123456789012:role/customer',
  externalId: '00000000000000000000000000000001',
  stackId: 'arn:aws:cloudformation:us-east-1:123456789012:stack/customer/12345678-abcd',
  bucket: 'sandbox-bucket',
  templateVersion: 1,
  subnetId: 'subnet-0123456789abcdef0',
  securityGroupId: 'sg-0123456789abcdef0',
  imageId: 'ami-0123456789abcdef0',
  instanceProfileArn: 'arn:aws:iam::123456789012:instance-profile/host',
  launchTemplateId: 'lt-0123456789abcdef0',
  launchTemplateVersion: 4,
  installation: '52ba9247-26af-434a-8dd7-ae70cc4cac47',
});
const instanceId = 'i-0123456789abcdef0';
const volumeId = 'vol-0123456789abcdef0';
const snapshotId = 'snap-0123456789abcdef0';
const generation = '1f9c29e6-4414-45b7-ae8f-2955a3557567';
const captureId = '76801a51-bcf3-43e7-95c6-2a96132bdad0';

function tags(values: Record<string, string>) {
  return `<tagSet>${Object.entries(values)
    .map(([name, value]) => `<item><key>${name}</key><value>${value}</value></item>`)
    .join('')}</tagSet>`;
}

const ownership = {
  [AWS_EC2_TAGS.installation]: config.installation,
  [AWS_EC2_TAGS.generation]: generation,
};

const vm = `<item><instanceId>${instanceId}</instanceId><imageId>${config.imageId}</imageId>
<instanceState><name>running</name></instanceState><instanceType>m7i.large</instanceType>
<subnetId>${config.subnetId}</subnetId><groupSet><item><groupId>${config.securityGroupId}</groupId></item></groupSet>
<networkInterfaceSet><item><networkInterfaceId>eni-0123456789abcdef0</networkInterfaceId></item></networkInterfaceSet>
<iamInstanceProfile><arn>${config.instanceProfileArn}</arn></iamInstanceProfile>
<metadataOptions><httpTokens>required</httpTokens><httpPutResponseHopLimit>1</httpPutResponseHopLimit><instanceMetadataTags>enabled</instanceMetadataTags></metadataOptions>
<blockDeviceMapping><item><deviceName>/dev/sdf</deviceName><ebs><volumeId>${volumeId}</volumeId><deleteOnTermination>true</deleteOnTermination></ebs></item></blockDeviceMapping>
${tags(ownership)}</item>`;
const reservation = (rows: string) =>
  `<ownerId>123456789012</ownerId><instancesSet>${rows}</instancesSet>`;
const observedSnapshot = `<snapshotId>${snapshotId}</snapshotId><ownerId>123456789012</ownerId>
<volumeId>${volumeId}</volumeId><status>pending</status>${tags({ ...ownership, [AWS_EC2_TAGS.capture]: captureId })}`;

function fixture(response: (action: string) => string) {
  const requests: URLSearchParams[] = [];
  const client = createAwsEc2Client({
    region: config.region,
    credentials: { accessKeyId: 'ASIATEST000000000000', secretAccessKey: 'synthetic-secret' },
    fetch: async request => {
      expect(request.url).toBe('https://ec2.us-east-1.amazonaws.com/');
      const body = new URLSearchParams(await request.text());
      requests.push(body);
      expect(body.get('Version')).toBe('2016-11-15');
      const action = body.get('Action') ?? '';
      return new Response(
        `<${action}Response xmlns="http://ec2.amazonaws.com/doc/2016-11-15/">${response(action)}</${action}Response>`
      );
    },
  });
  return { client, requests };
}

describe('EC2 sandbox query client', () => {
  it('pins the launch template and generation and seeds only the encrypted data disk', async () => {
    const { client, requests } = fixture(() => reservation(vm));
    const observed = await client.runInstance(config, generation, snapshotId);
    expect(observed.id).toBe(instanceId);
    expect(observed.volumes).toEqual([
      { device: '/dev/sdf', id: volumeId, deleteOnTermination: true },
    ]);
    expect(Object.fromEntries(requests[0])).toMatchObject({
      Action: 'RunInstances',
      ClientToken: generation,
      MinCount: '1',
      MaxCount: '1',
      'LaunchTemplate.Version': '4',
      'LaunchTemplate.LaunchTemplateId': config.launchTemplateId,
      'BlockDeviceMapping.1.DeviceName': '/dev/sdf',
      'BlockDeviceMapping.1.Ebs.SnapshotId': snapshotId,
      'BlockDeviceMapping.1.Ebs.Encrypted': 'true',
      'TagSpecification.1.ResourceType': 'instance',
      'TagSpecification.2.ResourceType': 'volume',
      'TagSpecification.2.Tag.2.Value': generation,
    });
    expect(requests[0].has('UserData')).toBe(false);
  });

  it('rejects a returned instance with a public address or modified ownership', async () => {
    const publicVm = vm.replace('<subnetId>', '<ipAddress>192.0.2.1</ipAddress><subnetId>');
    await expect(
      fixture(() => reservation(publicVm)).client.runInstance(config, generation)
    ).rejects.toMatchObject({ code: 'Ec2ConfigurationMismatch' });
    const { client } = fixture(
      () => `<reservationSet><item>${reservation(vm)}</item></reservationSet>`
    );
    const found = await client.describeInstance(instanceId);
    if (found === null) throw new Error('Expected the test instance');
    expect(() => assertAwsEc2Instance(found, config, captureId)).toThrow('Ec2OwnershipMismatch');
  });

  it('keeps the ownership proof AWS returns after terminating an instance', async () => {
    const terminated = vm
      .replace('<name>running</name>', '<name>terminated</name>')
      .replace(/<subnetId>.*?<\/subnetId>/, '')
      .replace(/<networkInterfaceSet>.*?<\/networkInterfaceSet>/, '<networkInterfaceSet/>');
    const { client } = fixture(
      () => `<reservationSet><item>${reservation(terminated)}</item></reservationSet>`
    );
    const observed = await client.describeInstance(instanceId);
    expect(observed).toMatchObject({ state: 'terminated', subnetId: undefined });
    if (observed === null) throw new Error('Expected the test instance');
    expect(() => assertAwsEc2Instance(observed, config, generation)).not.toThrow();
  });

  it.each([
    [vm + vm, ''],
    [vm, '<nextToken>more</nextToken>'],
  ])('rejects an ambiguous instance lookup', async (rows, page) => {
    const { client } = fixture(
      () => `<reservationSet><item>${reservation(rows)}</item></reservationSet>${page}`
    );
    await expect(client.findGeneration(config, generation)).rejects.toMatchObject({
      code: 'InvalidEc2Response',
    });
  });

  it('accepts stop submission as stopping and identifies an accepted snapshot by its durable capture tag', async () => {
    const { client, requests } = fixture(action => {
      if (action === 'StopInstances') {
        return `<instancesSet><item><instanceId>${instanceId}</instanceId><currentState><name>stopping</name></currentState></item></instancesSet>`;
      }
      return action === 'CreateSnapshot'
        ? observedSnapshot
        : `<snapshotSet><item>${observedSnapshot}</item></snapshotSet>`;
    });
    expect(await client.stop(instanceId)).toBe('stopping');
    const captured = await client.createSnapshot(config, volumeId, generation, captureId);
    expect(captured).toMatchObject({ id: snapshotId, volumeId, state: 'pending' });
    expect(await client.findSnapshot(config, { captureId })).toEqual(captured);
    expect(Object.fromEntries(requests[2])).toMatchObject({
      'Owner.1': 'self',
      'Filter.1.Value.1': config.installation,
      'Filter.2.Value.1': captureId,
    });
  });

  it('treats a missing snapshot as deleted after a lost successful response', async () => {
    const client = createAwsEc2Client({
      region: config.region,
      credentials: { accessKeyId: 'ASIATEST000000000000', secretAccessKey: 'synthetic-secret' },
      fetch: async () =>
        new Response(
          '<Response><Errors><Error><Code>InvalidSnapshot.NotFound</Code><Message>private text</Message></Error></Errors></Response>',
          { status: 400 }
        ),
    });
    await expect(client.deleteSnapshot(snapshotId)).resolves.toBeUndefined();
  });
});
