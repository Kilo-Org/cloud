import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { format } from 'oxfmt';

const directory = new URL('./', import.meta.url);
const ref = name => ({ Ref: name });
const sub = value => ({ 'Fn::Sub': value });
const attr = (name, key = 'Arn') => ({ 'Fn::GetAtt': [name, key] });
const allow = (Action, Resource, Condition) => ({
  Effect: 'Allow',
  Action,
  Resource,
  ...(Condition ? { Condition } : {}),
});
const trust = Service => ({
  Version: '2012-10-17',
  Statement: [{ Effect: 'Allow', Principal: { Service }, Action: 'sts:AssumeRole' }],
});
const policy = (PolicyName, Statement) => ({
  PolicyName,
  PolicyDocument: { Version: '2012-10-17', Statement },
});

/** The MicroVM template remains the shared network, proxy, DNS and storage source. Only compute differs. */
export function buildAwsEcsTemplate() {
  const template = JSON.parse(readFileSync(new URL('template.json', directory), 'utf8'));
  template.Description =
    'Kilo AWS ECS MVP: Nitro isolated tasks, shared authenticated proxy, private artifacts and two-hop customer access.';
  template.Metadata = {
    KiloTemplateVersion: 1,
    KiloProvider: 'aws-ecs',
    KiloSharedInfrastructureVersion: 2,
  };
  for (const name of ['RuntimeArtifactBucket', 'RuntimeArtifactKey'])
    delete template.Parameters[name];
  template.Parameters.RuntimeImageUri = {
    Type: 'String',
    Description: 'Immutable AMD64 Kilo runtime image in private ECR, pinned by digest.',
    AllowedPattern:
      '[0-9]{12}[.]dkr[.]ecr[.]us-east-1[.]amazonaws[.]com/[a-z0-9._/-]+@sha256:[a-f0-9]{64}',
  };
  template.Parameters.RuntimeRepositoryArn.Description =
    'The private ECR repository that contains the pinned runtime image.';
  const resources = template.Resources;
  for (const name of ['ConnectorOperatorRole', 'Connector', 'BuildRole', 'RuntimeImage'])
    delete resources[name];
  resources.SandboxCluster = { Type: 'AWS::ECS::Cluster' };
  resources.SandboxHostSecurityGroup = {
    Type: 'AWS::EC2::SecurityGroup',
    Properties: {
      GroupDescription:
        'Managed host control traffic; isolated tasks use their own proxy-only security group',
      VpcId: ref('Vpc'),
      SecurityGroupEgress: [{ IpProtocol: 'tcp', FromPort: 443, ToPort: 443, CidrIp: '0.0.0.0/0' }],
    },
  };
  resources.EcsEndpointSecurityGroup = {
    Type: 'AWS::EC2::SecurityGroup',
    Properties: {
      GroupDescription: 'Only managed hosts can reach ECS control endpoints',
      VpcId: ref('Vpc'),
      SecurityGroupIngress: [
        {
          IpProtocol: 'tcp',
          FromPort: 443,
          ToPort: 443,
          SourceSecurityGroupId: ref('SandboxHostSecurityGroup'),
        },
      ],
      SecurityGroupEgress: [{ IpProtocol: '-1', CidrIp: '127.0.0.1/32' }],
    },
  };
  for (const [name, service] of [
    ['EcsEndpoint', 'ecs'],
    ['EcsAgentEndpoint', 'ecs-agent'],
    ['EcsTelemetryEndpoint', 'ecs-telemetry'],
  ]) {
    resources[name] = {
      Type: 'AWS::EC2::VPCEndpoint',
      Properties: {
        VpcId: ref('Vpc'),
        VpcEndpointType: 'Interface',
        PrivateDnsEnabled: true,
        ServiceName: sub(`com.amazonaws.\${AWS::Region}.${service}`),
        SubnetIds: [ref('PrivateSubnet')],
        SecurityGroupIds: [ref('EcsEndpointSecurityGroup')],
      },
    };
  }
  // PrivateLink discovery returns fixed agent/telemetry hostnames. Never enumerate public shard names.
  resources.EcsBootstrapDnsDomains = {
    Type: 'AWS::Route53Resolver::FirewallDomainList',
    Properties: {
      Domains: [
        sub('ecs.${AWS::Region}.amazonaws.com'),
        sub('ecs-a.${AWS::Region}.amazonaws.com'),
        sub('ecs-t.${AWS::Region}.amazonaws.com'),
        { 'Fn::Select': [0, { 'Fn::Split': ['/', ref('RuntimeImageUri')] }] },
      ],
    },
  };
  resources.DnsRules.Properties.FirewallRules.unshift({
    Action: 'ALLOW',
    Priority: 50,
    FirewallDomainListId: ref('EcsBootstrapDnsDomains'),
    FirewallDomainRedirectionAction: 'TRUST_REDIRECTION_DOMAIN',
  });
  resources.SandboxInstanceRole = {
    Type: 'AWS::IAM::Role',
    Properties: {
      AssumeRolePolicyDocument: trust('ec2.amazonaws.com'),
      ManagedPolicyArns: [
        sub('arn:${AWS::Partition}:iam::aws:policy/AmazonECSInstanceRolePolicyForManagedInstances'),
      ],
    },
  };
  resources.SandboxInstanceProfile = {
    Type: 'AWS::IAM::InstanceProfile',
    Properties: { Roles: [ref('SandboxInstanceRole')] },
  };
  resources.SandboxInfrastructureRole = {
    Type: 'AWS::IAM::Role',
    Properties: {
      AssumeRolePolicyDocument: trust('ecs.amazonaws.com'),
      ManagedPolicyArns: [
        sub(
          'arn:${AWS::Partition}:iam::aws:policy/AmazonECSInfrastructureRolePolicyForManagedInstances'
        ),
      ],
      // The AWS managed policy's ecsInstanceRole* pattern does not match generated CloudFormation names.
      Policies: [
        policy('PassOnlyThisInstanceRole', [
          allow('iam:PassRole', attr('SandboxInstanceRole'), {
            StringLike: { 'iam:PassedToService': 'ec2.*' },
          }),
        ]),
      ],
    },
  };
  resources.SandboxCapacity = {
    Type: 'AWS::ECS::CapacityProvider',
    DependsOn: [
      'NatRoute',
      'EcsEndpoint',
      'EcsAgentEndpoint',
      'EcsTelemetryEndpoint',
      'DnsFirewall',
    ],
    Properties: {
      ClusterName: ref('SandboxCluster'),
      ManagedInstancesProvider: {
        InfrastructureRoleArn: attr('SandboxInfrastructureRole'),
        InstanceLaunchTemplate: {
          Ec2InstanceProfileArn: attr('SandboxInstanceProfile'),
          CapacityOptionType: 'ON_DEMAND',
          NitroEnclavesEnabled: true,
          NetworkConfiguration: {
            Subnets: [ref('PrivateSubnet')],
            SecurityGroups: [ref('SandboxHostSecurityGroup')],
          },
          InstanceRequirements: {
            VCpuCount: { Min: 8, Max: 8 },
            MemoryMiB: { Min: 32768, Max: 32768 },
            AllowedInstanceTypes: ['m7i.2xlarge'],
          },
          StorageConfiguration: { StorageSizeGiB: 80 },
        },
        InfrastructureOptimization: { ScaleInAfter: 60 },
      },
    },
  };
  resources.SandboxCapacityAssociation = {
    Type: 'AWS::ECS::ClusterCapacityProviderAssociations',
    Properties: {
      Cluster: ref('SandboxCluster'),
      CapacityProviders: [ref('SandboxCapacity')],
      DefaultCapacityProviderStrategy: [{ CapacityProvider: ref('SandboxCapacity'), Weight: 1 }],
    },
  };
  resources.SandboxExecutionRole = {
    Type: 'AWS::IAM::Role',
    Properties: {
      AssumeRolePolicyDocument: trust('ecs-tasks.amazonaws.com'),
      Policies: [
        policy('PullRuntimeAndWriteLogs', [
          allow('ecr:GetAuthorizationToken', '*'),
          allow(
            ['ecr:BatchCheckLayerAvailability', 'ecr:GetDownloadUrlForLayer', 'ecr:BatchGetImage'],
            ref('RuntimeRepositoryArn')
          ),
          allow(['logs:CreateLogStream', 'logs:PutLogEvents'], attr('Logs')),
        ]),
      ],
    },
  };
  resources.SandboxTask = {
    Type: 'AWS::ECS::TaskDefinition',
    Properties: {
      Cpu: '2048',
      Memory: '8192',
      NetworkMode: 'awsvpc',
      RequiresCompatibilities: ['MANAGED_INSTANCES'],
      RuntimePlatform: { CpuArchitecture: 'X86_64', OperatingSystemFamily: 'LINUX' },
      TrustedExecutionConfiguration: { IsolationMode: 'ISOLATED_SANDBOX' },
      ExecutionRoleArn: attr('SandboxExecutionRole'),
      ContainerDefinitions: [
        {
          Name: 'sandbox',
          Image: ref('RuntimeImageUri'),
          Essential: true,
          EntryPoint: ['/usr/local/bin/node'],
          Command: ['-e', 'console.error("Missing Kilo launch capability");process.exit(1)'],
          LogConfiguration: {
            LogDriver: 'awslogs',
            Options: {
              'awslogs-group': ref('Logs'),
              'awslogs-region': ref('AWS::Region'),
              'awslogs-stream-prefix': 'sandbox',
              mode: 'non-blocking',
              'max-buffer-size': '1m',
            },
          },
        },
      ],
    },
  };
  const lifecycle = resources.CustomerRole.Properties.Policies[0].PolicyDocument.Statement;
  resources.CustomerRole.Properties.Policies[0].PolicyDocument.Statement = [
    ...lifecycle.filter(
      statement => ![statement.Action].flat().some(action => action.startsWith('lambda:'))
    ),
    allow('ecs:RunTask', ref('SandboxTask'), {
      ArnEquals: { 'ecs:cluster': attr('SandboxCluster') },
      'ForAllValues:ArnEquals': {
        'ecs:capacity-provider': sub(
          'arn:${AWS::Partition}:ecs:${AWS::Region}:${AWS::AccountId}:capacity-provider/${SandboxCapacity}'
        ),
      },
      Null: { 'ecs:capacity-provider': 'false' },
      StringEquals: { 'ecs:enable-execute-command': 'false' },
    }),
    // ECS does not support resource-level authorization for this metadata read.
    allow('ecs:DescribeTaskDefinition', '*', {
      StringEquals: { 'aws:RequestedRegion': ref('AWS::Region') },
    }),
    // Discovery is read-only and restricted to this cluster, including its managed instances.
    allow('ecs:ListTasks', '*', {
      ArnEquals: { 'ecs:cluster': attr('SandboxCluster') },
      StringEquals: { 'aws:RequestedRegion': ref('AWS::Region') },
    }),
    allow(
      ['ecs:DescribeTasks', 'ecs:StopTask'],
      sub('arn:${AWS::Partition}:ecs:${AWS::Region}:${AWS::AccountId}:task/${SandboxCluster}/*'),
      { ArnEquals: { 'ecs:cluster': attr('SandboxCluster') } }
    ),
    allow('iam:PassRole', attr('SandboxExecutionRole'), {
      StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' },
    }),
  ];
  for (const name of ['ImageArn', 'ImageVersion', 'ConnectorArn']) delete template.Outputs[name];
  Object.assign(template.Outputs, {
    TemplateVersion: { Value: '1' },
    Provider: { Value: 'aws-ecs' },
    ClusterArn: { Value: attr('SandboxCluster') },
    TaskDefinitionArn: { Value: ref('SandboxTask') },
    CapacityProvider: { Value: ref('SandboxCapacity') },
    ExecutionRoleArn: { Value: attr('SandboxExecutionRole') },
    RuntimeImage: { Value: ref('RuntimeImageUri') },
  });
  return template;
}
export async function renderAwsEcsTemplate() {
  const result = await format('template.ecs.json', JSON.stringify(buildAwsEcsTemplate(), null, 2), {
    printWidth: 100,
    tabWidth: 2,
    endOfLine: 'lf',
  });
  if (result.errors.length) throw new Error('ECS template formatting failed');
  return result.code;
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const target = new URL('template.ecs.json', directory);
  const text = await renderAwsEcsTemplate();
  if (process.argv.slice(2).length > 1 || (process.argv[2] && process.argv[2] !== '--check'))
    throw new Error('Usage: node build-ecs-template.mjs [--check]');
  if (process.argv[2] === '--check') {
    if (readFileSync(target, 'utf8') !== text)
      throw new Error('ECS template is stale; run build:aws-ecs-template');
  } else writeFileSync(target, text);
}
