import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { buildAwsEcsTemplate, renderAwsEcsTemplate } from './build-ecs-template.mjs';

const source = JSON.parse(readFileSync(new URL('template.json', import.meta.url), 'utf8'));
const target = new URL('template.ecs.json', import.meta.url);
test('generated ECS release stays current and leaves the MicroVM source unchanged', async () => {
  assert.equal(readFileSync(target, 'utf8'), await renderAwsEcsTemplate());
  assert.deepEqual(
    source,
    JSON.parse(readFileSync(new URL('template.json', import.meta.url), 'utf8'))
  );
  assert.equal(source.Resources.RuntimeImage.Type, 'AWS::Lambda::MicrovmImage');
});
test('both engines use the same network, proxy, DNS and private artifact infrastructure', () => {
  const ecs = buildAwsEcsTemplate();
  for (const [name, resource] of Object.entries(source.Resources)) {
    if (
      [
        'ConnectorOperatorRole',
        'Connector',
        'BuildRole',
        'RuntimeImage',
        'CustomerRole',
        'DnsRules',
      ].includes(name)
    )
      continue;
    assert.deepEqual(ecs.Resources[name], resource, name);
  }
  assert.deepEqual(
    ecs.Resources.DnsRules.Properties.FirewallRules.slice(1),
    source.Resources.DnsRules.Properties.FirewallRules
  );
  assert.equal(ecs.Resources.SandboxSecurityGroup.Properties.SecurityGroupIngress, undefined);
  assert.deepEqual(ecs.Resources.SandboxSecurityGroup.Properties.SecurityGroupEgress, [
    {
      IpProtocol: 'tcp',
      FromPort: 3128,
      ToPort: 3128,
      DestinationSecurityGroupId: { Ref: 'ProxyLoadBalancerSecurityGroup' },
    },
  ]);
});
test('ECS task has Nitro isolation, no task role or external mounts, and the shared Node loader entrypoint', () => {
  const task = buildAwsEcsTemplate().Resources.SandboxTask.Properties;
  assert.deepEqual(task.TrustedExecutionConfiguration, { IsolationMode: 'ISOLATED_SANDBOX' });
  assert.deepEqual(task.RequiresCompatibilities, ['MANAGED_INSTANCES']);
  assert.equal(task.NetworkMode, 'awsvpc');
  assert.equal(task.TaskRoleArn, undefined);
  assert.equal(task.Volumes, undefined);
  assert.deepEqual(task.ContainerDefinitions[0].EntryPoint, ['/usr/local/bin/node']);
  assert.equal(task.ContainerDefinitions[0].Environment, undefined);
  assert.equal(task.ContainerDefinitions[0].Secrets, undefined);
  assert.deepEqual(task.ContainerDefinitions[0].Image, { Ref: 'RuntimeImageUri' });
  assert.match(buildAwsEcsTemplate().Parameters.RuntimeImageUri.AllowedPattern, /@sha256/);
});
test('managed hosts enable Nitro, use private networking, and scale in after idle cleanup', () => {
  const ecs = buildAwsEcsTemplate();
  const capacity = ecs.Resources.SandboxCapacity.Properties.ManagedInstancesProvider;
  assert.equal(capacity.InstanceLaunchTemplate.NitroEnclavesEnabled, true);
  assert.equal(capacity.InstanceLaunchTemplate.CapacityOptionType, 'ON_DEMAND');
  assert.deepEqual(capacity.InstanceLaunchTemplate.NetworkConfiguration, {
    Subnets: [{ Ref: 'PrivateSubnet' }],
    SecurityGroups: [{ Ref: 'SandboxHostSecurityGroup' }],
  });
  assert.equal(capacity.InfrastructureOptimization.ScaleInAfter, 60);
  assert.equal(ecs.Resources.SandboxHostSecurityGroup.Properties.SecurityGroupIngress, undefined);
  const pass =
    ecs.Resources.SandboxInfrastructureRole.Properties.Policies[0].PolicyDocument.Statement[0];
  assert.deepEqual(pass.Resource, { 'Fn::GetAtt': ['SandboxInstanceRole', 'Arn'] });
});
test('customer lifecycle authority targets one exact task definition, cluster, capacity and execution role', () => {
  const ecs = buildAwsEcsTemplate();
  const statements = ecs.Resources.CustomerRole.Properties.Policies[0].PolicyDocument.Statement;
  const run = statements.find(statement => statement.Action === 'ecs:RunTask');
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
  const discovery = statements.filter(statement => statement.Action === 'ecs:ListTasks');
  assert.equal(discovery.length, 1);
  assert.equal(discovery[0].Resource, '*');
  assert.deepEqual(discovery[0].Condition, {
    ArnEquals: { 'ecs:cluster': { 'Fn::GetAtt': ['SandboxCluster', 'Arn'] } },
    StringEquals: { 'aws:RequestedRegion': { Ref: 'AWS::Region' } },
  });
  const pass = statements.find(statement => statement.Action === 'iam:PassRole');
  assert.deepEqual(pass.Resource, { 'Fn::GetAtt': ['SandboxExecutionRole', 'Arn'] });
  assert.equal(pass.Condition.StringEquals['iam:PassedToService'], 'ecs-tasks.amazonaws.com');
  const actions = statements.flatMap(statement => [statement.Action].flat());
  assert.equal(
    actions.some(action => action.startsWith('lambda:')),
    false
  );
  for (const action of [
    'ecs:ExecuteCommand',
    'ecs:RegisterTaskDefinition',
    'ecs:CreateService',
    'ec2:RunInstances',
  ])
    assert.equal(actions.includes(action), false);
});
test('task-definition metadata read uses AWS-required wildcard authority in only the stack region', () => {
  const statements =
    buildAwsEcsTemplate().Resources.CustomerRole.Properties.Policies[0].PolicyDocument.Statement;
  const reads = statements.filter(statement => statement.Action === 'ecs:DescribeTaskDefinition');
  assert.equal(reads.length, 1);
  assert.equal(reads[0].Resource, '*');
  assert.deepEqual(reads[0].Condition, {
    StringEquals: { 'aws:RequestedRegion': { Ref: 'AWS::Region' } },
  });
});
test('shared S3 and proxy permissions remain the same for both customer roles', () => {
  const ecs = buildAwsEcsTemplate();
  const retained =
    source.Resources.CustomerRole.Properties.Policies[0].PolicyDocument.Statement.filter(
      statement => ![statement.Action].flat().some(action => action.startsWith('lambda:'))
    );
  const statements = ecs.Resources.CustomerRole.Properties.Policies[0].PolicyDocument.Statement;
  assert.deepEqual(statements.slice(0, retained.length), retained);
});

test('private ECS discovery keeps bootstrap DNS exact and endpoint ingress restricted to managed hosts', () => {
  const ecs = buildAwsEcsTemplate();
  for (const name of ['EcsEndpoint', 'EcsAgentEndpoint', 'EcsTelemetryEndpoint']) {
    assert.equal(ecs.Resources[name].Properties.PrivateDnsEnabled, true);
    assert.deepEqual(ecs.Resources[name].Properties.SecurityGroupIds, [
      { Ref: 'EcsEndpointSecurityGroup' },
    ]);
  }
  assert.deepEqual(ecs.Resources.EcsEndpointSecurityGroup.Properties.SecurityGroupIngress, [
    {
      IpProtocol: 'tcp',
      FromPort: 443,
      ToPort: 443,
      SourceSecurityGroupId: { Ref: 'SandboxHostSecurityGroup' },
    },
  ]);
  const domains = ecs.Resources.EcsBootstrapDnsDomains.Properties.Domains;
  assert.equal(domains.length, 4);
  assert.equal(JSON.stringify(domains).includes('*'), false);
  for (const name of ['ecs', 'ecs-a', 'ecs-t'])
    assert.ok(domains.some(domain => domain['Fn::Sub'] === name + '.${AWS::Region}.amazonaws.com'));
});
