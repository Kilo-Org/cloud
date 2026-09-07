import {
  sessionAttachPayloadSchema,
  sessionPromptPayloadSchema,
} from '../../../src/shared/sandbox-control-protocol.js';

export function operationIntent(operation: 'session.attach' | 'session.prompt', payload: unknown) {
  if (operation === 'session.prompt') {
    const { attachments, ...intent } = sessionPromptPayloadSchema.parse(payload);
    return {
      ...intent,
      attachments: attachments?.map(({ filename, mime, localPath }) => ({
        filename,
        mime,
        localPath,
      })),
    };
  }
  const { kilo, git, env, snapshotIdentity, directory, branch, setupCommands, preparation } =
    sessionAttachPayloadSchema.parse(payload);
  const credentials = new Set([
    'KILOCODE_TOKEN',
    'KILOCODE_ORGANIZATION_ID',
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'GITLAB_TOKEN',
    'GITLAB_OAUTH_TOKEN',
    'BITBUCKET_TOKEN',
    'BITBUCKET_APP_PASSWORD',
  ]);
  return {
    snapshotIdentity,
    directory,
    branch,
    setupCommands,
    preparation,
    kilo: kilo
      ? {
          scopeId: kilo.scopeId,
          organizationId: kilo.organizationId,
          containmentEnabled: kilo.containmentEnabled !== false,
          targets: kilo.targets,
        }
      : undefined,
    git: git ? { url: git.url, platform: git.platform } : undefined,
    env: Object.fromEntries(Object.entries(env ?? {}).filter(([key]) => !credentials.has(key))),
  };
}
