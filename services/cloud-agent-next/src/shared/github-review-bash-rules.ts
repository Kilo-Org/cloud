const SUMMARY_COMMENT_ENDPOINTS = ['repos/*/issues/*/comments', 'repos/*/issues/comments/*'];

const SUMMARY_WRITE_FLAGS = ['--method', '-X', '--input', '-f', '-F', '--field', '--raw-field'];

// A graphql request is denied whatever operation it carries, because the
// operation can arrive from a file or from stdin. Each rule names the endpoint
// argument of `gh api`.
const GRAPHQL_ENDPOINT_TOKENS = ['graphql', '/graphql'];

const COMMENT_SUBCOMMANDS = ['gh issue comment', 'gh pr comment'];

/**
 * Comment writes on the reviewed pull request belong to the trusted publisher.
 * The map denies every `gh` form that creates or edits a conversation comment,
 * in any flag order and regardless of a command prefix. The CLI matcher
 * anchors whole-command globs and lets the last matching pattern win, so the
 * map holds denials only: no entry here lifts a denial for a longer command
 * text. Paginated reads and inline review writes on pull review endpoints keep
 * the verdict of the command guard, which allows them.
 */
export function buildGitHubReviewBashRules(): Record<string, 'deny'> {
  const denies: Record<string, 'deny'> = {};
  for (const endpoint of SUMMARY_COMMENT_ENDPOINTS) {
    for (const flag of SUMMARY_WRITE_FLAGS) {
      denies[`gh api ${flag}*${endpoint}*`] = 'deny';
      denies[`gh api * ${flag}*${endpoint}*`] = 'deny';
      denies[`gh api ${endpoint}* ${flag}*`] = 'deny';
      // Matched anywhere in the command text (a leading wildcard allows a
      // wrapper prefix or a surrounding command), so a write form cannot move
      // out of reach. The flag keeps its argument boundary: it is either the
      // first argument, where the `gh api` separator is the boundary, or a
      // later argument, written after a space. A flag token quoted inside a
      // `--jq` expression therefore keeps the command-guard verdict.
      denies[`*gh api ${flag}*${endpoint}*`] = 'deny';
      denies[`*gh api * ${flag}*${endpoint}*`] = 'deny';
      denies[`*gh api *${endpoint}* ${flag}*`] = 'deny';
    }
  }
  // A pull request is an issue, so both comment subcommands reach the same
  // conversation comment.
  for (const subcommand of COMMENT_SUBCOMMANDS) {
    denies[subcommand] = 'deny';
    denies[`${subcommand} *`] = 'deny';
    denies[`*${subcommand}*`] = 'deny';
  }
  // Every `gh api` call that reaches the graphql endpoint is denied, with the
  // endpoint written first or after a flag, and with a wrapper prefix or a
  // surrounding command. The endpoint is the first argument that is not a
  // flag, which is the position the rules name.
  for (const token of GRAPHQL_ENDPOINT_TOKENS) {
    denies[`gh api ${token}`] = 'deny';
    denies[`gh api ${token} *`] = 'deny';
    denies[`*gh api ${token}*`] = 'deny';
    denies[`*gh api -* ${token}*`] = 'deny';
  }
  return denies;
}
