import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// template.ecs.json is the only AWS release template. These checks hold its security contract.
const template = JSON.parse(readFileSync(new URL('template.ecs.json', import.meta.url), 'utf8'));
const resources = template.Resources;
const customerStatements = resources.CustomerRole.Properties.Policies[0].PolicyDocument.Statement;
const customerActions = customerStatements.flatMap(statement => [statement.Action].flat());

test('the release template declares ECS and contains no Lambda resource or authority', () => {
  assert.equal(template.Metadata.KiloProvider, 'aws-ecs');
  assert.deepEqual(template.Outputs.Provider, { Value: 'aws-ecs' });
  for (const [name, resource] of Object.entries(resources))
    assert.equal(resource.Type.startsWith('AWS::Lambda::'), false, name);
  assert.equal(
    customerActions.some(action => action.startsWith('lambda:')),
    false
  );
});
test('the customer role reads only public proxy metadata and writes only launch and archive objects', () => {
  const s3 = customerStatements.filter(statement =>
    [statement.Action].flat().some(action => action.startsWith('s3:'))
  );
  assert.deepEqual(s3, [
    {
      Effect: 'Allow',
      Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
      Resource: [
        { 'Fn::Sub': '${Artifacts.Arn}/kilo/launch/*' },
        { 'Fn::Sub': '${Artifacts.Arn}/kilo/archives/*' },
      ],
    },
    {
      Effect: 'Allow',
      Action: 's3:GetObject',
      Resource: [
        { 'Fn::Sub': '${Artifacts.Arn}/kilo/proxy/public/deployment.json' },
        { 'Fn::Sub': '${Artifacts.Arn}/kilo/proxy/shared/auth.json' },
      ],
    },
  ]);
  assert.equal(JSON.stringify(resources.CustomerRole).includes('/kilo/proxy/private/'), false);
});
test('sandbox tasks accept no ingress and reach only the authenticated proxy', () => {
  assert.equal(resources.SandboxSecurityGroup.Properties.SecurityGroupIngress, undefined);
  assert.deepEqual(resources.SandboxSecurityGroup.Properties.SecurityGroupEgress, [
    {
      IpProtocol: 'tcp',
      FromPort: 3128,
      ToPort: 3128,
      DestinationSecurityGroupId: { Ref: 'ProxyLoadBalancerSecurityGroup' },
    },
  ]);
});
test('ECS task has Nitro isolation, no task role or external mounts, and the shared Node loader entrypoint', () => {
  const task = resources.SandboxTask.Properties;
  assert.deepEqual(task.TrustedExecutionConfiguration, { IsolationMode: 'ISOLATED_SANDBOX' });
  assert.deepEqual(task.RequiresCompatibilities, ['MANAGED_INSTANCES']);
  assert.equal(task.NetworkMode, 'awsvpc');
  assert.equal(task.TaskRoleArn, undefined);
  assert.equal(task.Volumes, undefined);
  assert.deepEqual(task.ContainerDefinitions[0].EntryPoint, ['/usr/local/bin/node']);
  assert.equal(task.ContainerDefinitions[0].Environment, undefined);
  assert.equal(task.ContainerDefinitions[0].Secrets, undefined);
  assert.deepEqual(task.ContainerDefinitions[0].Image, { Ref: 'RuntimeImageUri' });
  assert.match(template.Parameters.RuntimeImageUri.AllowedPattern, /@sha256/);
});
test('managed hosts enable Nitro, use private networking, and scale in after idle cleanup', () => {
  const capacity = resources.SandboxCapacity.Properties.ManagedInstancesProvider;
  assert.equal(capacity.InstanceLaunchTemplate.NitroEnclavesEnabled, true);
  assert.equal(capacity.InstanceLaunchTemplate.CapacityOptionType, 'ON_DEMAND');
  assert.deepEqual(capacity.InstanceLaunchTemplate.NetworkConfiguration, {
    Subnets: [{ Ref: 'PrivateSubnet' }],
    SecurityGroups: [{ Ref: 'SandboxHostSecurityGroup' }],
  });
  assert.equal(capacity.InfrastructureOptimization.ScaleInAfter, 60);
  assert.equal(resources.SandboxHostSecurityGroup.Properties.SecurityGroupIngress, undefined);
  const pass =
    resources.SandboxInfrastructureRole.Properties.Policies[0].PolicyDocument.Statement[0];
  assert.deepEqual(pass.Resource, { 'Fn::GetAtt': ['SandboxInstanceRole', 'Arn'] });
});
test('customer lifecycle authority targets one exact task definition, cluster, capacity and execution role', () => {
  const run = customerStatements.find(statement => statement.Action === 'ecs:RunTask');
  assert.deepEqual(run.Resource, { Ref: 'SandboxTask' });
  assert.deepEqual(run.Condition.ArnEquals, {
    'ecs:cluster': { 'Fn::GetAtt': ['SandboxCluster', 'Arn'] },
  });
  assert.deepEqual(run.Condition['ForAllValues:ArnEquals'], {
    'ecs:capacity-provider': {
      'Fn::Sub':
        'arn:${AWS::Partition}:ecs:${AWS::Region}:${AWS::AccountId}:capacity-provider/${SandboxCapacity}',
    },
  });
  assert.equal(run.Condition.StringEquals['ecs:enable-execute-command'], 'false');
  const discovery = customerStatements.filter(statement => statement.Action === 'ecs:ListTasks');
  assert.equal(discovery.length, 1);
  assert.equal(discovery[0].Resource, '*');
  assert.deepEqual(discovery[0].Condition, {
    ArnEquals: { 'ecs:cluster': { 'Fn::GetAtt': ['SandboxCluster', 'Arn'] } },
    StringEquals: { 'aws:RequestedRegion': { Ref: 'AWS::Region' } },
  });
  const pass = customerStatements.find(statement => statement.Action === 'iam:PassRole');
  assert.deepEqual(pass.Resource, { 'Fn::GetAtt': ['SandboxExecutionRole', 'Arn'] });
  assert.equal(pass.Condition.StringEquals['iam:PassedToService'], 'ecs-tasks.amazonaws.com');
  for (const action of [
    'ecs:ExecuteCommand',
    'ecs:RegisterTaskDefinition',
    'ecs:CreateService',
    'ec2:RunInstances',
  ])
    assert.equal(customerActions.includes(action), false);
});
test('task-definition metadata read uses AWS-required wildcard authority in only the stack region', () => {
  const reads = customerStatements.filter(
    statement => statement.Action === 'ecs:DescribeTaskDefinition'
  );
  assert.equal(reads.length, 1);
  assert.equal(reads[0].Resource, '*');
  assert.deepEqual(reads[0].Condition, {
    StringEquals: { 'aws:RequestedRegion': { Ref: 'AWS::Region' } },
  });
});
test('private ECS discovery keeps bootstrap DNS exact and endpoint ingress restricted to managed hosts', () => {
  for (const name of ['EcsEndpoint', 'EcsAgentEndpoint', 'EcsTelemetryEndpoint']) {
    assert.equal(resources[name].Properties.PrivateDnsEnabled, true);
    assert.deepEqual(resources[name].Properties.SecurityGroupIds, [
      { Ref: 'EcsEndpointSecurityGroup' },
    ]);
  }
  assert.deepEqual(resources.EcsEndpointSecurityGroup.Properties.SecurityGroupIngress, [
    {
      IpProtocol: 'tcp',
      FromPort: 443,
      ToPort: 443,
      SourceSecurityGroupId: { Ref: 'SandboxHostSecurityGroup' },
    },
  ]);
  const domains = resources.EcsBootstrapDnsDomains.Properties.Domains;
  assert.equal(domains.length, 4);
  assert.equal(JSON.stringify(domains).includes('*'), false);
  for (const name of ['ecs', 'ecs-a', 'ecs-t'])
    assert.ok(domains.some(domain => domain['Fn::Sub'] === name + '.${AWS::Region}.amazonaws.com'));
  assert.equal(
    resources.DnsRules.Properties.FirewallRules[0].FirewallDomainListId.Ref,
    'EcsBootstrapDnsDomains'
  );
});
