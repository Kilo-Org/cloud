import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { groupedRegisterSessionInput } from '../../helpers/session-setup.js';

const gitlabCodeReviewTokenRef = {
  integrationId: '123e4567-e89b-12d3-a456-426614174011',
  projectId: 42,
};

function getSessionStub(sessionId: string) {
  const doId = env.CLOUD_AGENT_SESSION.idFromName(`user_gitlab_review:${sessionId}`);
  return env.CLOUD_AGENT_SESSION.get(doId);
}

describe('CloudAgentSession GitLab code-review token references', () => {
  it('stores only a reference for authorized GitLab code-review sessions', async () => {
    const stub = getSessionStub('agent_gitlab-review-authorized');

    const result = await runInDurableObject(stub, async instance => {
      const registration = await instance.registerSession(
        groupedRegisterSessionInput({
          sessionId: 'agent_gitlab-review-authorized',
          userId: 'user_gitlab_review',
          prompt: 'Review the merge request',
          mode: 'code',
          model: 'test-model',
          gitUrl: 'https://gitlab.com/acme/repo.git',
          platform: 'gitlab',
          createdOnPlatform: 'code-review',
          gitlabCodeReviewTokenRef,
        })
      );
      return { registration, metadata: await instance.getMetadata() };
    });

    expect(result.registration.success).toBe(true);
    expect(result.metadata?.repository).toMatchObject({
      type: 'gitlab',
      url: 'https://gitlab.com/acme/repo.git',
      platform: 'gitlab',
      gitlabCodeReviewTokenRef,
    });
    expect(result.metadata?.repository).not.toHaveProperty('token');
  });

  it('rejects references when registration origin is not code review', async () => {
    const stub = getSessionStub('agent_gitlab-review-unauthorized');

    const result = await runInDurableObject(stub, async instance => {
      const registration = await instance.registerSession(
        groupedRegisterSessionInput({
          sessionId: 'agent_gitlab-review-unauthorized',
          userId: 'user_gitlab_review',
          prompt: 'Interactive session',
          mode: 'code',
          model: 'test-model',
          gitUrl: 'https://gitlab.com/acme/repo.git',
          platform: 'gitlab',
          gitlabCodeReviewTokenRef,
        })
      );
      return { registration, metadata: await instance.getMetadata() };
    });

    expect(result.registration.success).toBe(false);
    expect(result.metadata).toBeNull();
  });

  it('attaches a reference during continuation and clears stale managed-token state', async () => {
    const stub = getSessionStub('agent_gitlab-review-upgrade');

    const metadata = await runInDurableObject(stub, async instance => {
      await instance.registerSession(
        groupedRegisterSessionInput({
          sessionId: 'agent_gitlab-review-upgrade',
          userId: 'user_gitlab_review',
          prompt: 'Review the merge request',
          mode: 'code',
          model: 'test-model',
          gitUrl: 'https://gitlab.com/acme/repo.git',
          platform: 'gitlab',
          createdOnPlatform: 'code-review',
        })
      );
      await instance.recordSessionReady({
        workspacePath: '/workspace/acme/repo',
        sandboxId: 'usr-abcdef',
        sessionHome: '/home/agent_gitlab-review-upgrade',
        branchName: 'main',
        kiloSessionId: 'kilo_gitlab_review_upgrade',
        gitlabTokenManaged: true,
      });
      const update = await instance.tryUpdate({
        callbackTarget: { url: 'https://example.com/callback' },
        gitlabCodeReviewTokenRef,
        gitlabCodeReviewRepositoryUrl: 'https://gitlab.com/acme/repo.git',
      });
      expect(update.success).toBe(true);
      return instance.getMetadata();
    });

    expect(metadata?.callback?.target.url).toBe('https://example.com/callback');
    expect(metadata?.repository).toMatchObject({
      type: 'gitlab',
      gitlabCodeReviewTokenRef,
    });
    expect(metadata?.repository).not.toHaveProperty('gitlabTokenManaged');
  });

  it('does not partially apply an unauthorized reference update', async () => {
    const stub = getSessionStub('agent_gitlab-review-update-rejected');

    const result = await runInDurableObject(stub, async instance => {
      await instance.registerSession(
        groupedRegisterSessionInput({
          sessionId: 'agent_gitlab-review-update-rejected',
          userId: 'user_gitlab_review',
          prompt: 'Interactive session',
          mode: 'code',
          model: 'test-model',
          gitUrl: 'https://gitlab.com/acme/repo.git',
          platform: 'gitlab',
        })
      );
      const update = await instance.tryUpdate({
        callbackTarget: { url: 'https://example.com/not-applied' },
        gitlabCodeReviewTokenRef,
        gitlabCodeReviewRepositoryUrl: 'https://gitlab.com/acme/repo.git',
      });
      return { update, metadata: await instance.getMetadata() };
    });

    expect(result.update.success).toBe(false);
    expect(result.metadata?.callback).toBeUndefined();
    expect(result.metadata?.repository).not.toHaveProperty('gitlabCodeReviewTokenRef');
  });

  it('rejects reference updates for a different GitLab repository URL', async () => {
    const stub = getSessionStub('agent_gitlab-review-url-rejected');

    const result = await runInDurableObject(stub, async instance => {
      await instance.registerSession(
        groupedRegisterSessionInput({
          sessionId: 'agent_gitlab-review-url-rejected',
          userId: 'user_gitlab_review',
          prompt: 'Review the merge request',
          mode: 'code',
          model: 'test-model',
          gitUrl: 'https://gitlab-a.example.com/acme/repo.git',
          platform: 'gitlab',
          createdOnPlatform: 'code-review',
        })
      );
      return instance.tryUpdate({
        gitlabCodeReviewTokenRef,
        gitlabCodeReviewRepositoryUrl: 'https://gitlab-b.example.com/acme/repo.git',
      });
    });

    expect(result.success).toBe(false);
  });

  it('rejects reference updates for non-GitLab code-review sessions', async () => {
    const stub = getSessionStub('agent_github-review-update-rejected');

    const result = await runInDurableObject(stub, async instance => {
      await instance.registerSession(
        groupedRegisterSessionInput({
          sessionId: 'agent_github-review-update-rejected',
          userId: 'user_gitlab_review',
          prompt: 'Review the pull request',
          mode: 'code',
          model: 'test-model',
          githubRepo: 'acme/repo',
          createdOnPlatform: 'code-review',
        })
      );
      return instance.tryUpdate({
        gitlabCodeReviewTokenRef,
        gitlabCodeReviewRepositoryUrl: 'https://gitlab.com/acme/repo.git',
      });
    });

    expect(result.success).toBe(false);
  });
});
