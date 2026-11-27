import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const template = JSON.parse(readFileSync(new URL('template.ec2.json', import.meta.url), 'utf8'));
const resources = template.Resources;
const controller = Object.fromEntries(
  resources.ControllerRole.Properties.Policies.flatMap(policy =>
    policy.PolicyDocument.Statement.map(statement => [statement.Sid, statement])
  )
);

test('the EC2 template launches a private host with encrypted disks and IMDSv2', () => {
  assert.equal(template.Metadata.KiloProvider, 'aws-ec2');
  assert.equal(template.Outputs.Provider.Value, 'aws-ec2');
  for (const [name, { Type }] of Object.entries(resources)) {
    assert.doesNotMatch(Type, /^AWS::(?:ECS|Lambda)::/, name);
    assert.notEqual(Type, 'AWS::EC2::SecurityGroupIngress', name);
  }
  const host = resources.HostLaunchTemplate.Properties.LaunchTemplateData;
  assert.deepEqual(host.ImageId, { Ref: 'HostAmiId' });
  assert.equal(host.InstanceType, 'm7i.large');
  assert.deepEqual(host.IamInstanceProfile, { Arn: { 'Fn::GetAtt': ['HostProfile', 'Arn'] } });
  assert.deepEqual(host.NetworkInterfaces, [
    {
      DeviceIndex: 0,
      AssociatePublicIpAddress: false,
      DeleteOnTermination: true,
      SubnetId: { Ref: 'PrivateSubnet' },
      Groups: [{ Ref: 'HostSecurityGroup' }],
    },
  ]);
  assert.equal(resources.HostSecurityGroup.Properties.SecurityGroupIngress, undefined);
  assert.deepEqual(resources.PrivateInternetRoute.Properties, {
    RouteTableId: { Ref: 'PrivateRoutes' },
    DestinationCidrBlock: '0.0.0.0/0',
    NatGatewayId: { Ref: 'NatGateway' },
  });
  assert.deepEqual(host.MetadataOptions, {
    HttpEndpoint: 'enabled',
    HttpProtocolIpv6: 'disabled',
    HttpPutResponseHopLimit: 1,
    HttpTokens: 'required',
    InstanceMetadataTags: 'enabled',
  });
  assert.deepEqual(
    host.BlockDeviceMappings.map(({ DeviceName, Ebs }) => [
      DeviceName,
      Ebs.Encrypted,
      Ebs.DeleteOnTermination,
      Ebs.VolumeType,
    ]),
    [
      ['/dev/xvda', true, true, 'gp3'],
      ['/dev/sdf', true, true, 'gp3'],
    ]
  );
});

test('the EC2 host role can only read its launch documents and write its stop markers', () => {
  const artifactActions = [
    ['s3:GetObject', 'launch'],
    ['s3:PutObject', 'stopped'],
  ];
  const host = resources.HostRole.Properties;
  assert.equal(host.ManagedPolicyArns, undefined);
  assert.deepEqual(resources.HostProfile.Properties.Roles, [{ Ref: 'HostRole' }]);
  assert.deepEqual(
    host.Policies.flatMap(policy => policy.PolicyDocument.Statement),
    artifactActions.map(([Action, prefix]) => ({
      Effect: 'Allow',
      Action,
      Resource: {
        'Fn::Join': [
          '',
          [{ 'Fn::GetAtt': ['Artifacts', 'Arn'] }, `/kilo/${prefix}/\${ec2:SourceInstanceARN}/*`],
        ],
      },
      Condition: {
        StringEquals: {
          'aws:SourceVpce': { Ref: 'ArtifactEndpoint' },
          'aws:VpcSourceIp': '${aws:Ec2InstanceSourcePrivateIPv4}',
        },
      },
    }))
  );
  const endpoint = resources.ArtifactEndpoint.Properties;
  assert.equal(endpoint.VpcEndpointType, 'Gateway');
  assert.deepEqual(endpoint.RouteTableIds, [{ Ref: 'PrivateRoutes' }]);
  assert.deepEqual(
    endpoint.PolicyDocument.Statement,
    artifactActions.map(([Action, prefix]) => ({
      Effect: 'Allow',
      Principal: '*',
      Action,
      Resource: { 'Fn::Sub': `\${Artifacts.Arn}/kilo/${prefix}/*` },
    }))
  );
  assert.deepEqual(resources.Artifacts.Properties.PublicAccessBlockConfiguration, {
    BlockPublicAcls: true,
    BlockPublicPolicy: true,
    IgnorePublicAcls: true,
    RestrictPublicBuckets: true,
  });
});

test('the EC2 controller restores only tagged, encrypted snapshots through its launch template', () => {
  const restore = controller.UseOwnWorkspaceSnapshots;
  assert.equal(restore.Action, 'ec2:RunInstances');
  assert.deepEqual(restore.Resource, {
    'Fn::Sub': 'arn:${AWS::Partition}:ec2:${AWS::Region}::snapshot/*',
  });
  assert.deepEqual(restore.Condition, {
    ArnEquals: { 'ec2:LaunchTemplate': controller.UseOwnLaunchTemplate.Resource },
    StringEquals: { 'aws:ResourceTag/KiloInstallation': { Ref: 'InstallationId' } },
    Bool: { 'ec2:Encrypted': 'true' },
    Null: { 'aws:ResourceTag/KiloSnapshotCapture': 'false' },
  });
  const passRoles = Object.values(controller).filter(statement =>
    [statement.Action].flat().includes('iam:PassRole')
  );
  assert.deepEqual(passRoles, [
    {
      Sid: 'PassOnlyHostRole',
      Effect: 'Allow',
      Action: 'iam:PassRole',
      Resource: { 'Fn::GetAtt': ['HostRole', 'Arn'] },
      Condition: { StringEquals: { 'iam:PassedToService': 'ec2.amazonaws.com' } },
    },
  ]);
});

test('the EC2 controller scopes lifecycle and snapshot operations to the installation', () => {
  for (const sid of [
    'ManageOwnedInstances',
    'SetOnlyAllocationHint',
    'DeleteOwnedDetachedVolumes',
    'CaptureOwnedVolumes',
    'DeleteOwnedSnapshots',
  ]) {
    assert.deepEqual(controller[sid].Condition.StringEquals, {
      'aws:ResourceTag/KiloInstallation': { Ref: 'InstallationId' },
    });
  }
  assert.deepEqual(controller.SetOnlyAllocationHint.Condition['ForAllValues:StringEquals'], {
    'aws:TagKeys': ['KiloAllocation'],
  });
  assert.deepEqual(controller.CreateTaggedSnapshots.Condition, {
    StringEquals: { 'aws:RequestTag/KiloInstallation': { Ref: 'InstallationId' } },
    Null: {
      'aws:RequestTag/KiloSandboxGeneration': 'false',
      'aws:RequestTag/KiloSnapshotCapture': 'false',
    },
  });
});
