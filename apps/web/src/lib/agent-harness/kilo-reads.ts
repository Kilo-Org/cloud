import 'server-only';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { toolDefinitions } from '@kilocode/agent-harness/tools';
import { rootRouter } from '@/routers/root-router';
import { SummaryOutputSchema } from '@/routers/usage-analytics-schemas';
import { authorizeHarnessCapability, harnessInputDigest } from './authorization';

const definitions = toolDefinitions.filter(
  tool =>
    tool.name === 'kilo.organizations' ||
    tool.name === 'kilo.members' ||
    tool.name === 'kilo.usage' ||
    tool.name === 'kilo.repositories'
);
const Id = z.uuid().transform(value => value.toLowerCase());
const InvocationSchema = z.strictObject({
  conversationId: Id,
  operationId: Id,
  name: z.enum(definitions.map(tool => tool.name)),
  arguments: z.unknown(),
});

export async function executeHarnessRead(token: string, input: unknown) {
  const invocation = InvocationSchema.parse(input);
  const definition = definitions.find(tool => tool.name === invocation.name);
  if (!definition) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Unknown resource read' });
  const args = definition.inputSchema.parse(invocation.arguments);
  const { ctx, authority } = await authorizeHarnessCapability(token, {
    audience: 'agent-harness:operations',
    conversationId: invocation.conversationId,
    operation: definition.name,
    definitionVersion: definition.version,
    inputDigest: harnessInputDigest(args),
    dispatchId: invocation.operationId,
    target: { kind: 'backend' },
  });
  const caller = rootRouter.createCaller(ctx);
  const organizationId = authority.organizationId;
  let output: unknown;
  switch (invocation.name) {
    case 'kilo.organizations': {
      const organizations = await caller.organizations.list();
      const scoped = organizations
        .flatMap(organization => [organization, ...organization.inheritedChildren])
        .filter(
          organization => organizationId === null || organization.organizationId === organizationId
        );
      const unique = new Map(
        scoped.map(organization => [organization.organizationId, organization])
      );
      output = [...unique.values()].slice(0, 50).map(organization => ({
        id: organization.organizationId,
        name: organization.organizationName,
      }));
      break;
    }
    case 'kilo.members': {
      if (organizationId === null) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Members require an organization conversation',
        });
      }
      const members = await caller.organizations.members.listPublic({ organizationId });
      output = members.slice(0, 50).map(member => ({
        // Pending invitations have no public user ID. Their email is their public identifier.
        id: member.status === 'active' ? member.id : member.email,
        email: member.email,
        role: member.role,
      }));
      break;
    }
    case 'kilo.usage': {
      // Match the existing past-month usage window; disclose its bounds in the result.
      const end = new Date();
      const start = new Date(end);
      start.setUTCDate(start.getUTCDate() - 30);
      const dates = { startDate: start.toISOString(), endDate: end.toISOString() };
      const summary = await caller.usageAnalytics.getSummary({
        ...dates,
        granularity: 'day',
        costSource: 'cost',
        personalScope: 'personal-only',
        ...(organizationId === null ? { viewAs: 'self' } : { organizationId, viewAs: 'org-wide' }),
      });
      output = { ...SummaryOutputSchema.parse(summary), ...dates };
      break;
    }
    case 'kilo.repositories': {
      const orgRepositories = caller.organizations.cloudAgentNext;
      const list = (procedure: 'listGitHubRepositories' | 'listGitLabRepositories') =>
        organizationId === null
          ? caller.cloudAgentNext[procedure]({ forceRefresh: false, bounded: true })
          : orgRepositories[procedure]({ organizationId, forceRefresh: false, bounded: true });
      const github = await list('listGitHubRepositories');
      const gitlab = await list('listGitLabRepositories');
      const providers = [
        ['github', github],
        ['gitlab', gitlab],
      ] as const;
      let available = false;
      const repositories: { id: string; name: string }[] = [];
      for (const [platform, result] of providers) {
        const status = result.status;
        if (status !== undefined && status !== 'available' && status !== 'not_connected') {
          const codes = {
            temporarily_unavailable: 'SERVICE_UNAVAILABLE',
            suspended: 'PRECONDITION_FAILED',
            reconnect_required: 'PRECONDITION_FAILED',
            misconfigured: 'PRECONDITION_FAILED',
            integration_limit_exceeded: 'PAYLOAD_TOO_LARGE',
          } as const;
          throw new TRPCError({
            code: codes[status],
            message: `${platform} repositories: ${status}`,
          });
        }
        // Bounded procedures provide explicit status; the legacy installed flag cannot prove absence.
        if (status === undefined || result.errorMessage) {
          throw new TRPCError({
            code: 'SERVICE_UNAVAILABLE',
            message: 'Repository integration read failed',
          });
        }
        if (status === 'available') {
          available = true;
          repositories.push(
            ...result.repositories
              .slice(0, 50 - repositories.length)
              .map(repo => ({ id: `${platform}:${repo.id}`, name: repo.fullName }))
          );
        }
      }
      // Personal Bitbucket is not exposed by the existing authorized router.
      if (organizationId !== null) {
        const bitbucket = await orgRepositories.listBitbucketRepositories({
          organizationId,
          forceRefresh: false,
          bounded: true,
        });
        if (bitbucket.status === 'available') {
          available = true;
          repositories.push(
            ...bitbucket.repositories
              .slice(0, 50 - repositories.length)
              .map(repo => ({ id: `bitbucket:${repo.id}`, name: repo.fullName }))
          );
        } else if (bitbucket.status !== 'not_connected') {
          const codes = {
            temporarily_unavailable: 'SERVICE_UNAVAILABLE',
            insufficient_permissions: 'FORBIDDEN',
            invalid_request: 'BAD_REQUEST',
            reconnect_required: 'PRECONDITION_FAILED',
            workspace_selection_required: 'PRECONDITION_FAILED',
          } as const;
          throw new TRPCError({
            code: codes[bitbucket.status],
            message: `Bitbucket repositories: ${bitbucket.status}`,
          });
        }
      }
      if (!available) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'No repository integration is available in this context',
        });
      }
      output = repositories.slice(0, 50);
      break;
    }
  }
  // Legacy lists have no cursor. Keep their consumers unchanged and return one bounded page.
  const result = definition.outputSchema.parse(output);
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 64 * 1024) {
    throw new TRPCError({ code: 'PAYLOAD_TOO_LARGE', message: 'Resource read exceeds 64 KiB' });
  }
  return result;
}
