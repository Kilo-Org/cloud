type Shape = {
  types: string[];
  scalars: string[];
  children?: Record<string, string>;
  arguments?: Record<string, string[]>;
};

const pageArguments = ['first', 'last', 'after', 'before'];
const repositoryScalars =
  'id databaseId name nameWithOwner url sshUrl description isPrivate isFork isArchived hasIssuesEnabled hasWikiEnabled viewerPermission mergeCommitAllowed rebaseMergeAllowed squashMergeAllowed'.split(
    ' '
  );
const pullScalars =
  'id databaseId number title body bodyText bodyHTML url state isDraft isCrossRepository headRefName headRefOid baseRefName baseRefOid mergeable mergeStateStatus merged mergedAt createdAt updatedAt closedAt additions deletions changedFiles viewerDidAuthor viewerCanUpdate viewerCanReact maintainerCanModify reviewDecision totalCommentsCount'.split(
    ' '
  );

// Each edge names the next allowed shape. In particular, related repositories expose identity
// metadata only; an owner, fork, or PR head must never lead to another repository's contents.
export const githubTaskGraphqlShapes: Record<string, Shape> = {
  query: {
    types: ['Query'],
    scalars: [],
    children: { repository: 'repository', viewer: 'actor', organization: 'owner', user: 'owner' },
    arguments: {
      repository: ['owner', 'name', 'followRenames'],
      organization: ['login'],
      user: ['login'],
    },
  },
  mutation: {
    types: ['Mutation'],
    scalars: [],
    children: {
      createPullRequest: 'pullPayload',
      createIssue: 'issuePayload',
      updateIssue: 'issuePayload',
      closeIssue: 'issuePayload',
      reopenIssue: 'issuePayload',
      updatePullRequest: 'pullPayload',
      closePullRequest: 'pullPayload',
      reopenPullRequest: 'pullPayload',
      markPullRequestReadyForReview: 'pullPayload',
      convertPullRequestToDraft: 'pullPayload',
      addComment: 'commentPayload',
      addPullRequestReview: 'reviewPayload',
    },
    arguments: {
      createPullRequest: ['input'],
      createIssue: ['input'],
      updateIssue: ['input'],
      closeIssue: ['input'],
      reopenIssue: ['input'],
      updatePullRequest: ['input'],
      closePullRequest: ['input'],
      reopenPullRequest: ['input'],
      markPullRequestReadyForReview: ['input'],
      convertPullRequestToDraft: ['input'],
      addComment: ['input'],
      addPullRequestReview: ['input'],
    },
  },
  repository: {
    types: ['Repository'],
    scalars: repositoryScalars,
    children: {
      owner: 'actor',
      defaultBranchRef: 'ref',
      parent: 'repositoryIdentity',
      pullRequest: 'pull',
      pullRequests: 'pullConnection',
      issue: 'issue',
      issues: 'issueConnection',
      issueOrPullRequest: 'pullOrIssue',
      object: 'gitObject',
      ref: 'ref',
      refs: 'refConnection',
      labels: 'labelConnection',
      milestones: 'milestoneConnection',
    },
    arguments: {
      pullRequest: ['number'],
      pullRequests: [...pageArguments, 'headRefName', 'baseRefName', 'states', 'labels', 'orderBy'],
      issue: ['number'],
      issues: [...pageArguments, 'states', 'labels', 'orderBy', 'filterBy'],
      issueOrPullRequest: ['number'],
      object: ['expression', 'oid'],
      ref: ['qualifiedName'],
      refs: [...pageArguments, 'refPrefix', 'query', 'orderBy'],
      labels: [...pageArguments, 'query', 'orderBy'],
      milestones: [...pageArguments, 'states', 'query', 'orderBy'],
    },
  },
  owner: {
    types: ['User', 'Organization'],
    scalars: ['id', 'databaseId', 'login', 'name', 'url', 'description'],
    children: { repositories: 'repositoryConnection' },
    arguments: { repositories: [...pageArguments, 'privacy', 'orderBy', 'isFork'] },
  },
  repositoryIdentity: {
    types: ['Repository'],
    scalars: repositoryScalars,
    children: { owner: 'actor', defaultBranchRef: 'refIdentity' },
  },
  actor: {
    types: ['Actor', 'User', 'Bot', 'Organization', 'Mannequin'],
    scalars: ['id', 'databaseId', 'login', 'name', 'url', 'avatarUrl', 'isBot'],
    arguments: { avatarUrl: ['size'] },
  },
  refIdentity: {
    types: ['Ref'],
    scalars: ['id', 'name', 'prefix'],
    children: { target: 'objectIdentity' },
  },
  objectIdentity: {
    types: ['GitObject', 'Commit', 'Blob', 'Tree', 'Tag'],
    scalars: ['id', 'oid', 'abbreviatedOid'],
  },
  ref: { types: ['Ref'], scalars: ['id', 'name', 'prefix'], children: { target: 'gitObject' } },
  gitObject: {
    types: ['GitObject', 'Commit', 'Blob', 'Tree', 'Tag'],
    scalars: [
      'id',
      'oid',
      'abbreviatedOid',
      'message',
      'messageHeadline',
      'committedDate',
      'authoredDate',
      'text',
      'isBinary',
      'byteSize',
      'truncated',
      'commitUrl',
      'url',
    ],
    children: {
      author: 'gitActor',
      committer: 'gitActor',
      tree: 'gitObject',
      entries: 'treeEntry',
      parents: 'commitConnection',
      history: 'commitConnection',
      statusCheckRollup: 'statusRollup',
    },
    arguments: { history: [...pageArguments, 'path', 'since', 'until'], parents: pageArguments },
  },
  gitActor: {
    types: ['GitActor'],
    scalars: ['name', 'email', 'date'],
    children: { user: 'actor' },
  },
  treeEntry: {
    types: ['TreeEntry'],
    scalars: ['name', 'path', 'oid', 'type', 'mode', 'size'],
    children: { object: 'gitObject' },
  },
  pull: {
    types: ['PullRequest'],
    scalars: pullScalars,
    children: {
      author: 'actor',
      headRepository: 'repositoryIdentity',
      baseRepository: 'repositoryIdentity',
      headRepositoryOwner: 'actor',
      repository: 'repositoryIdentity',
      headRef: 'refIdentity',
      baseRef: 'refIdentity',
      comments: 'commentConnection',
      reviews: 'reviewConnection',
      commits: 'pullCommitConnection',
      labels: 'labelConnection',
      milestone: 'milestone',
      assignees: 'actorConnection',
      assignedActors: 'actorConnection',
      autoMergeRequest: 'autoMergeRequest',
      reviewRequests: 'reviewRequestConnection',
      reactionGroups: 'reactionGroup',
      projectItems: 'projectItemConnection',
    },
    arguments: {
      comments: pageArguments,
      reviews: [...pageArguments, 'states', 'author'],
      commits: pageArguments,
      labels: pageArguments,
      assignees: pageArguments,
      assignedActors: pageArguments,
      reviewRequests: pageArguments,
      projectItems: pageArguments,
    },
  },
  issue: {
    types: ['Issue'],
    scalars: [
      'id',
      'databaseId',
      'number',
      'title',
      'body',
      'url',
      'state',
      'createdAt',
      'updatedAt',
      'closedAt',
    ],
    children: {
      author: 'actor',
      comments: 'commentConnection',
      labels: 'labelConnection',
      milestone: 'milestone',
      assignees: 'actorConnection',
    },
    arguments: { comments: pageArguments, labels: pageArguments, assignees: pageArguments },
  },
  pullOrIssue: { types: ['Issue', 'PullRequest'], scalars: ['id'], children: {} },
  comment: {
    types: ['IssueComment', 'PullRequestReviewComment'],
    scalars: [
      'id',
      'databaseId',
      'body',
      'bodyText',
      'url',
      'createdAt',
      'updatedAt',
      'viewerDidAuthor',
      'authorAssociation',
      'includesCreatedEdit',
      'isMinimized',
      'minimizedReason',
    ],
    children: { author: 'actor', reactionGroups: 'reactionGroup' },
  },
  review: {
    types: ['PullRequestReview'],
    scalars: ['id', 'databaseId', 'body', 'state', 'submittedAt', 'authorAssociation'],
    children: {
      author: 'actor',
      comments: 'commentConnection',
      commit: 'objectIdentity',
      reactionGroups: 'reactionGroup',
    },
    arguments: { comments: pageArguments },
  },
  label: { types: ['Label'], scalars: ['id', 'name', 'description', 'color', 'url'] },
  milestone: {
    types: ['Milestone'],
    scalars: ['id', 'number', 'title', 'description', 'url', 'state', 'dueOn'],
  },
  autoMergeRequest: {
    types: ['AutoMergeRequest'],
    scalars: ['authorEmail', 'commitBody', 'commitHeadline', 'mergeMethod', 'enabledAt'],
    children: { enabledBy: 'actor' },
  },
  reviewRequest: {
    types: ['ReviewRequest'],
    scalars: [],
    children: { requestedReviewer: 'reviewerIdentity' },
  },
  reviewerIdentity: {
    types: ['RequestedReviewer', 'User', 'Bot', 'Team'],
    scalars: ['id', 'login', 'name', 'slug'],
    children: { organization: 'actor' },
  },
  reactionGroup: {
    types: ['ReactionGroup'],
    scalars: ['content'],
    children: { users: 'reactionUsers' },
  },
  reactionUsers: { types: ['ReactingUserConnection'], scalars: ['totalCount'] },
  projectItem: {
    types: ['ProjectV2Item'],
    scalars: ['id'],
    children: { project: 'projectIdentity', fieldValueByName: 'projectStatus' },
    arguments: { fieldValueByName: ['name'] },
  },
  projectIdentity: { types: ['ProjectV2'], scalars: ['id', 'title'] },
  projectStatus: {
    types: ['ProjectV2ItemFieldValue', 'ProjectV2ItemFieldSingleSelectValue'],
    scalars: ['optionId', 'name'],
  },
  pullCommit: { types: ['PullRequestCommit'], scalars: [], children: { commit: 'gitObject' } },
  statusRollup: {
    types: ['StatusCheckRollup'],
    scalars: ['state'],
    children: { contexts: 'checkConnection' },
    arguments: { contexts: pageArguments },
  },
  check: {
    types: ['StatusContext', 'CheckRun'],
    scalars: [
      'id',
      'name',
      'context',
      'state',
      'status',
      'conclusion',
      'description',
      'detailsUrl',
      'targetUrl',
      'startedAt',
      'completedAt',
      'createdAt',
    ],
    children: { checkSuite: 'checkSuite' },
  },
  checkSuite: {
    types: ['CheckSuite'],
    scalars: [],
    children: { workflowRun: 'workflowRun' },
  },
  workflowRun: {
    types: ['WorkflowRun'],
    scalars: [],
    children: { workflow: 'workflowIdentity' },
  },
  workflowIdentity: { types: ['Workflow'], scalars: ['name'] },
  pageInfo: {
    types: ['PageInfo'],
    scalars: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  },
  pullPayload: {
    types: [
      'CreatePullRequestPayload',
      'UpdatePullRequestPayload',
      'ClosePullRequestPayload',
      'ReopenPullRequestPayload',
      'MarkPullRequestReadyForReviewPayload',
      'ConvertPullRequestToDraftPayload',
    ],
    scalars: ['clientMutationId'],
    children: { pullRequest: 'pull' },
  },
  issuePayload: {
    types: ['CreateIssuePayload', 'UpdateIssuePayload', 'CloseIssuePayload', 'ReopenIssuePayload'],
    scalars: ['clientMutationId'],
    children: { issue: 'issue' },
  },
  commentPayload: {
    types: ['AddCommentPayload'],
    scalars: ['clientMutationId'],
    children: { commentEdge: 'commentEdge' },
  },
  reviewPayload: {
    types: ['AddPullRequestReviewPayload'],
    scalars: ['clientMutationId'],
    children: { pullRequestReview: 'review' },
  },
};

for (const [name, node, type] of [
  ['repository', 'repository', 'Repository'],
  ['pull', 'pull', 'PullRequest'],
  ['issue', 'issue', 'Issue'],
  ['comment', 'comment', 'IssueComment'],
  ['review', 'review', 'PullRequestReview'],
  ['reviewRequest', 'reviewRequest', 'ReviewRequest'],
  ['projectItem', 'projectItem', 'ProjectV2Item'],
  ['label', 'label', 'Label'],
  ['milestone', 'milestone', 'Milestone'],
  ['actor', 'actor', 'User'],
  ['commit', 'gitObject', 'Commit'],
  ['ref', 'ref', 'Ref'],
  ['pullCommit', 'pullCommit', 'PullRequestCommit'],
  ['check', 'check', 'StatusCheckRollupContext'],
]) {
  githubTaskGraphqlShapes[`${name}Connection`] = {
    types: [`${type}Connection`],
    scalars: ['totalCount'],
    children: { nodes: node, edges: `${name}Edge`, pageInfo: 'pageInfo' },
  };
  githubTaskGraphqlShapes[`${name}Edge`] = {
    types: [`${type}Edge`],
    scalars: ['cursor'],
    children: { node },
  };
}
