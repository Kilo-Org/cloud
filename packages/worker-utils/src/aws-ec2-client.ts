import { z } from 'zod';
import { AwsRequestError, createAwsClient, readAwsResponse } from './aws-client';
import { createAwsQueryXmlReader } from './aws-query-xml';
import {
  AWS_EC2_DATA_DEVICE,
  AWS_EC2_INSTANCE_TYPE,
  AWS_EC2_TAGS,
  awsEc2AccountIdSchema,
  awsEc2ImageIdSchema,
  awsEc2InstanceIdSchema,
  awsEc2InstanceProfileArnSchema,
  awsEc2NetworkInterfaceIdSchema,
  awsEc2SecurityGroupIdSchema,
  awsEc2SnapshotIdSchema,
  awsEc2SubnetIdSchema,
  awsEc2VolumeIdSchema,
  type AwsEc2ByocConfiguration,
} from './aws-ec2';

const version = '2016-11-15';
const namespace = `http://ec2.amazonaws.com/doc/${version}/`;
const instanceState = z.enum([
  'pending',
  'running',
  'stopping',
  'stopped',
  'shutting-down',
  'terminated',
]);
const snapshotState = z.enum(['pending', 'completed', 'error', 'recoverable', 'recovering']);
const volumeState = z.enum(['creating', 'available', 'in-use', 'deleting', 'deleted', 'error']);

// A malformed mutation response can follow a successful AWS operation. Its caller must reconcile.
function invalid(): never {
  throw new AwsRequestError(0, 'InvalidEc2Response');
}
const { parse, child, required, scalar, optionalScalar, items } = createAwsQueryXmlReader(
  namespace,
  invalid
);
type XmlNode = ReturnType<typeof parse>;

function read<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  return result.success ? result.data : invalid();
}

function bool(node: XmlNode, field: string) {
  return read(z.enum(['true', 'false']), scalar(node, field)) === 'true';
}

function tags(node: XmlNode) {
  const result = new Map<string, string>();
  for (const item of items(node, 'tagSet', 'item')) {
    const key = scalar(item, 'key');
    if (result.has(key)) invalid();
    result.set(key, scalar(item, 'value'));
  }
  return result;
}

function instance(node: XmlNode, accountId: string) {
  const profile = child(node, 'iamInstanceProfile');
  const metadata = child(node, 'metadataOptions');
  const subnet = optionalScalar(node, 'subnetId');
  return {
    accountId,
    id: read(awsEc2InstanceIdSchema, scalar(node, 'instanceId')),
    imageId: read(awsEc2ImageIdSchema, scalar(node, 'imageId')),
    state: read(instanceState, scalar(required(node, 'instanceState'), 'name')),
    type: scalar(node, 'instanceType'),
    subnetId: subnet === undefined ? undefined : read(awsEc2SubnetIdSchema, subnet),
    securityGroups: items(node, 'groupSet', 'item').map(group =>
      read(awsEc2SecurityGroupIdSchema, scalar(group, 'groupId'))
    ),
    rootDevice: optionalScalar(node, 'rootDeviceName'),
    networkInterfaces: items(node, 'networkInterfaceSet', 'item').map(network => ({
      id: read(awsEc2NetworkInterfaceIdSchema, scalar(network, 'networkInterfaceId')),
      publicIp: child(network, 'association') !== undefined,
      hasIpv6: items(network, 'ipv6AddressesSet', 'item').length > 0,
    })),
    publicIp: child(node, 'ipAddress') !== undefined,
    profileArn: profile && read(awsEc2InstanceProfileArnSchema, scalar(profile, 'arn')),
    metadata: metadata && {
      tokens: scalar(metadata, 'httpTokens'),
      hopLimit: scalar(metadata, 'httpPutResponseHopLimit'),
      instanceTags: scalar(metadata, 'instanceMetadataTags'),
    },
    volumes: items(node, 'blockDeviceMapping', 'item').map(mapping => {
      const ebs = required(mapping, 'ebs');
      return {
        device: scalar(mapping, 'deviceName'),
        id: read(awsEc2VolumeIdSchema, scalar(ebs, 'volumeId')),
        deleteOnTermination: bool(ebs, 'deleteOnTermination'),
      };
    }),
    tags: tags(node),
  };
}

export type AwsEc2Instance = ReturnType<typeof instance>;

function volume(node: XmlNode) {
  return {
    id: read(awsEc2VolumeIdSchema, scalar(node, 'volumeId')),
    encrypted: bool(node, 'encrypted'),
    state: read(volumeState, scalar(node, 'status')),
    attachments: items(node, 'attachmentSet', 'item').map(attachment => ({
      instanceId: read(awsEc2InstanceIdSchema, scalar(attachment, 'instanceId')),
      device: scalar(attachment, 'device'),
      state: scalar(attachment, 'status'),
      deleteOnTermination: bool(attachment, 'deleteOnTermination'),
    })),
    tags: tags(node),
  };
}

export function assertAwsEc2Ownership(
  vm: AwsEc2Instance,
  config: AwsEc2ByocConfiguration,
  generation: string
) {
  if (
    vm.accountId !== config.roleArn.split(':')[4] ||
    vm.tags.get(AWS_EC2_TAGS.installation) !== config.installation ||
    vm.tags.get(AWS_EC2_TAGS.generation) !== generation
  )
    throw new AwsRequestError(422, 'Ec2OwnershipMismatch');
}

/** Check the actual VM before conveying any runtime grant. */
export function assertAwsEc2Instance(
  vm: AwsEc2Instance,
  config: AwsEc2ByocConfiguration,
  generation: string
) {
  assertAwsEc2Ownership(vm, config, generation);
  if (vm.state === 'terminated' || vm.state === 'shutting-down') return;
  if (
    vm.imageId !== config.imageId ||
    vm.type !== AWS_EC2_INSTANCE_TYPE ||
    vm.subnetId !== config.subnetId ||
    vm.securityGroups.length !== 1 ||
    vm.securityGroups[0] !== config.securityGroupId ||
    vm.publicIp ||
    vm.networkInterfaces.length !== 1 ||
    vm.networkInterfaces[0].publicIp ||
    vm.networkInterfaces[0].hasIpv6 ||
    vm.profileArn !== config.instanceProfileArn ||
    vm.metadata?.tokens !== 'required' ||
    vm.metadata.hopLimit !== '1' ||
    vm.metadata.instanceTags !== 'enabled'
  )
    throw new AwsRequestError(422, 'Ec2ConfigurationMismatch');
}

function snapshot(node: XmlNode) {
  const encrypted = optionalScalar(node, 'encrypted');
  return {
    id: read(awsEc2SnapshotIdSchema, scalar(node, 'snapshotId')),
    volumeId: read(awsEc2VolumeIdSchema, scalar(node, 'volumeId')),
    accountId: read(awsEc2AccountIdSchema, scalar(node, 'ownerId')),
    state: read(snapshotState, scalar(node, 'status')),
    encrypted:
      encrypted === undefined ? undefined : read(z.enum(['true', 'false']), encrypted) === 'true',
    tags: tags(node),
  };
}

export type AwsEc2Snapshot = ReturnType<typeof snapshot>;

function tagSpecification(
  resource: 'instance' | 'volume' | 'snapshot',
  index: number,
  values: Readonly<Record<string, string>>
): Record<string, string> {
  const prefix = `TagSpecification.${index}`;
  return Object.fromEntries([
    [`${prefix}.ResourceType`, resource] as const,
    ...Object.entries(values).flatMap(([key, value], offset) => [
      [`${prefix}.Tag.${offset + 1}.Key`, key] as const,
      [`${prefix}.Tag.${offset + 1}.Value`, value] as const,
    ]),
  ]);
}

function filter(name: string, value: string, index = 1) {
  return { [`Filter.${index}.Name`]: name, [`Filter.${index}.Value.1`]: value };
}

function ec2HostUserData(config: AwsEc2ByocConfiguration) {
  return btoa(
    [
      '#cloud-config',
      'write_files:',
      '  - path: /etc/kilo-ec2/host.conf',
      '    owner: root:root',
      "    permissions: '0600'",
      '    content: |',
      `      AWS_REGION=${config.region}`,
      `      KILO_LAUNCH_BUCKET=${config.bucket}`,
      'runcmd:',
      '  - [systemctl, restart, kilo-ec2.service]',
      '',
    ].join('\n')
  );
}

function assertLaunchTemplate(root: XmlNode, config: AwsEc2ByocConfiguration) {
  function mismatch(): never {
    throw new AwsRequestError(422, 'Ec2LaunchTemplateMismatch');
  }
  const [row, extra] = items(root, 'launchTemplateVersionSet', 'item');
  if (!row || extra || child(root, 'nextToken')) mismatch();
  const data = required(row, 'launchTemplateData');
  const profile = required(data, 'iamInstanceProfile');
  const metadata = required(data, 'metadataOptions');
  const [network, extraNetwork] = items(data, 'networkInterfaceSet', 'item');
  const group = network && child(network, 'groupSet');
  if (
    scalar(row, 'launchTemplateId') !== config.launchTemplateId ||
    scalar(row, 'versionNumber') !== String(config.launchTemplateVersion) ||
    scalar(data, 'imageId') !== config.imageId ||
    scalar(data, 'instanceType') !== AWS_EC2_INSTANCE_TYPE ||
    scalar(data, 'userData') !== ec2HostUserData(config) ||
    scalar(data, 'instanceInitiatedShutdownBehavior') !== 'stop' ||
    scalar(profile, 'arn') !== config.instanceProfileArn ||
    scalar(metadata, 'httpTokens') !== 'required' ||
    scalar(metadata, 'httpPutResponseHopLimit') !== '1' ||
    scalar(metadata, 'httpEndpoint') !== 'enabled' ||
    scalar(metadata, 'httpProtocolIpv6') !== 'disabled' ||
    scalar(metadata, 'instanceMetadataTags') !== 'enabled' ||
    !network ||
    extraNetwork ||
    scalar(network, 'deviceIndex') !== '0' ||
    scalar(network, 'subnetId') !== config.subnetId ||
    bool(network, 'associatePublicIpAddress') ||
    !bool(network, 'deleteOnTermination') ||
    group?.children.length !== 1 ||
    scalar(group, 'groupId') !== config.securityGroupId ||
    ['keyName', 'kernelId', 'ramDiskId', 'secondaryInterfaceSet', 'instanceMarketOptions'].some(
      field => child(data, field)
    ) ||
    [
      'networkInterfaceId',
      'ipv6AddressesSet',
      'ipv6AddressCount',
      'ipv6PrefixSet',
      'ipv6PrefixCount',
    ].some(field => child(network, field))
  )
    mismatch();
  const volumes = items(data, 'blockDeviceMappingSet', 'item');
  if (volumes.length !== 2) mismatch();
  for (const [device, size] of [
    ['/dev/xvda', '16'],
    [AWS_EC2_DATA_DEVICE, '32'],
  ]) {
    const volume = volumes.find(entry => scalar(entry, 'deviceName') === device);
    if (!volume) mismatch();
    const ebs = required(volume, 'ebs');
    if (
      !bool(ebs, 'encrypted') ||
      !bool(ebs, 'deleteOnTermination') ||
      scalar(ebs, 'volumeType') !== 'gp3' ||
      scalar(ebs, 'volumeSize') !== size ||
      child(ebs, 'snapshotId')
    )
      mismatch();
  }
}

export function createAwsEc2Client(
  input: Omit<Parameters<typeof createAwsClient>[0], 'service' | 'readErrorCode'>
) {
  const client = createAwsClient({
    ...input,
    service: 'ec2',
    async readErrorCode(response) {
      const root = parse(await readAwsResponse(response, 32_768), 'Response');
      return scalar(required(required(root, 'Errors'), 'Error'), 'Code');
    },
  });
  async function query(action: string, parameters: Record<string, string>, signal?: AbortSignal) {
    const response = await client.request(`https://ec2.${input.region}.amazonaws.com/`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ Action: action, Version: version, ...parameters }).toString(),
      signal,
    });
    return parse(await readAwsResponse(response, 1024 * 1024), `${action}Response`);
  }

  function instances(reservation: XmlNode) {
    const accountId = read(awsEc2AccountIdSchema, scalar(reservation, 'ownerId'));
    return items(reservation, 'instancesSet', 'item').map(row => instance(row, accountId));
  }

  async function findInstance(
    parameters: Record<string, string>,
    signal?: AbortSignal
  ): Promise<AwsEc2Instance | null> {
    const root = await query('DescribeInstances', parameters, signal);
    const matches = items(root, 'reservationSet', 'item').flatMap(instances);
    if (child(root, 'nextToken') || matches.length > 1) invalid();
    return matches[0] ?? null;
  }

  async function changeState(
    action: 'StartInstances' | 'StopInstances' | 'TerminateInstances',
    id: string
  ) {
    const root = await query(action, { 'InstanceId.1': awsEc2InstanceIdSchema.parse(id) });
    const rows = items(root, 'instancesSet', 'item');
    if (rows.length !== 1 || scalar(rows[0], 'instanceId') !== id) invalid();
    return read(instanceState, scalar(required(rows[0], 'currentState'), 'name'));
  }

  async function volumes(parameters: Record<string, string>, signal?: AbortSignal) {
    const root = await query('DescribeVolumes', parameters, signal);
    if (child(root, 'nextToken')) invalid();
    return items(root, 'volumeSet', 'item');
  }

  return {
    async validateLaunchTemplate(config: AwsEc2ByocConfiguration, signal?: AbortSignal) {
      const root = await query(
        'DescribeLaunchTemplateVersions',
        {
          LaunchTemplateId: config.launchTemplateId,
          'LaunchTemplateVersion.1': String(config.launchTemplateVersion),
        },
        signal
      );
      assertLaunchTemplate(root, config);
    },
    async runInstance(
      config: AwsEc2ByocConfiguration,
      generation: string,
      restoreSnapshotId?: string
    ) {
      const ownership = {
        [AWS_EC2_TAGS.installation]: config.installation,
        [AWS_EC2_TAGS.generation]: z.uuid().parse(generation),
      };
      const root = await query('RunInstances', {
        MinCount: '1',
        MaxCount: '1',
        ClientToken: generation,
        'LaunchTemplate.LaunchTemplateId': config.launchTemplateId,
        'LaunchTemplate.Version': String(config.launchTemplateVersion),
        ...tagSpecification('instance', 1, ownership),
        ...tagSpecification('volume', 2, ownership),
        ...(restoreSnapshotId === undefined
          ? {}
          : {
              'BlockDeviceMapping.1.DeviceName': AWS_EC2_DATA_DEVICE,
              'BlockDeviceMapping.1.Ebs.SnapshotId':
                awsEc2SnapshotIdSchema.parse(restoreSnapshotId),
              'BlockDeviceMapping.1.Ebs.Encrypted': 'true',
              'BlockDeviceMapping.1.Ebs.VolumeType': 'gp3',
              'BlockDeviceMapping.1.Ebs.DeleteOnTermination': 'true',
            }),
      });
      const vms = instances(root);
      if (vms.length !== 1) invalid();
      assertAwsEc2Instance(vms[0], config, generation);
      return vms[0];
    },
    async describeInstance(id: string, signal?: AbortSignal) {
      const vm = await findInstance(
        filter('instance-id', awsEc2InstanceIdSchema.parse(id)),
        signal
      );
      if (vm && vm.id !== id) invalid();
      return vm;
    },
    findGeneration(config: AwsEc2ByocConfiguration, generation: string, signal?: AbortSignal) {
      return findInstance(
        {
          ...filter(`tag:${AWS_EC2_TAGS.installation}`, config.installation),
          ...filter(`tag:${AWS_EC2_TAGS.generation}`, z.uuid().parse(generation), 2),
        },
        signal
      );
    },
    start: (id: string) => changeState('StartInstances', id),
    stop: (id: string) => changeState('StopInstances', id),
    terminate: (id: string) => changeState('TerminateInstances', id),
    async setAllocation(instanceId: string, allocationId: string) {
      const root = await query('CreateTags', {
        'ResourceId.1': awsEc2InstanceIdSchema.parse(instanceId),
        'Tag.1.Key': AWS_EC2_TAGS.allocation,
        'Tag.1.Value': z.uuid().parse(allocationId),
      });
      if (!bool(root, 'return')) invalid();
    },
    async describeVolume(
      id: string,
      signal?: AbortSignal
    ): Promise<ReturnType<typeof volume> | null> {
      const rows = await volumes(filter('volume-id', awsEc2VolumeIdSchema.parse(id)), signal);
      if (rows.length > 1) invalid();
      const found = rows[0] && volume(rows[0]);
      if (found && found.id !== id) invalid();
      return found ?? null;
    },
    async generationVolumes(config: AwsEc2ByocConfiguration, generation: string) {
      const rows = await volumes({
        ...filter(`tag:${AWS_EC2_TAGS.installation}`, config.installation),
        ...filter(`tag:${AWS_EC2_TAGS.generation}`, z.uuid().parse(generation), 2),
      });
      return rows.map(volume);
    },
    async deleteVolume(id: string) {
      try {
        const root = await query('DeleteVolume', { VolumeId: awsEc2VolumeIdSchema.parse(id) });
        if (!bool(root, 'return')) invalid();
      } catch (error) {
        if (!(error instanceof AwsRequestError && error.code === 'InvalidVolume.NotFound'))
          throw error;
      }
    },
    async createSnapshot(
      config: AwsEc2ByocConfiguration,
      volumeId: string,
      generation: string,
      captureId: string
    ) {
      const root = await query('CreateSnapshot', {
        VolumeId: awsEc2VolumeIdSchema.parse(volumeId),
        ...tagSpecification('snapshot', 1, {
          [AWS_EC2_TAGS.installation]: config.installation,
          [AWS_EC2_TAGS.generation]: z.uuid().parse(generation),
          [AWS_EC2_TAGS.capture]: z.uuid().parse(captureId),
        }),
      });
      const captured = snapshot(root);
      if (captured.volumeId !== volumeId || captured.accountId !== config.roleArn.split(':')[4])
        invalid();
      return captured;
    },
    async findSnapshot(
      config: AwsEc2ByocConfiguration,
      lookup: { id: string } | { captureId: string }
    ) {
      const root = await query('DescribeSnapshots', {
        'Owner.1': 'self',
        ...filter(`tag:${AWS_EC2_TAGS.installation}`, config.installation),
        ...('id' in lookup
          ? filter('snapshot-id', awsEc2SnapshotIdSchema.parse(lookup.id), 2)
          : filter(`tag:${AWS_EC2_TAGS.capture}`, z.uuid().parse(lookup.captureId), 2)),
      });
      const rows = items(root, 'snapshotSet', 'item');
      if (child(root, 'nextToken') || rows.length > 1) invalid();
      if (rows.length === 0) return null;
      const found = snapshot(rows[0]);
      if (
        found.accountId !== config.roleArn.split(':')[4] ||
        found.tags.get(AWS_EC2_TAGS.installation) !== config.installation ||
        ('id' in lookup
          ? found.id !== lookup.id
          : found.tags.get(AWS_EC2_TAGS.capture) !== lookup.captureId)
      )
        invalid();
      return found;
    },
    async deleteSnapshot(id: string) {
      try {
        const root = await query('DeleteSnapshot', {
          SnapshotId: awsEc2SnapshotIdSchema.parse(id),
        });
        if (!bool(root, 'return')) invalid();
      } catch (error) {
        if (!(error instanceof AwsRequestError && error.code === 'InvalidSnapshot.NotFound'))
          throw error;
      }
    },
  };
}

export type AwsEc2Client = ReturnType<typeof createAwsEc2Client>;
