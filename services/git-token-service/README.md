# Cloud Agent GitHub capabilities

The token service accepts container-bound legacy `kgh2` and task-scoped `kgh3` capabilities. Existing callers without `taskScope` keep legacy issuance, credential selection, and request policy. Task issuance and redemption reject provided credentials with `provided_token_not_supported`.

Deploy this compatible reader before Cloud Agent starts issuing task capabilities. Existing workspaces need no migration. Once task capabilities exist, rollback must retain support for both formats.

Task verification performs live repository identity checks before forwarding authorization. Each repository-candidate verification permits at most 16 distinct lookups, including the task repository. Repeated GraphQL selections share one lookup. Excessive selections fail before network access.

Task and workspace policies require current repository authority. The local resource-helper regression
measures one repository lookup, one scoped-token exchange, and one selected-repository validation
for a user-source request without a cached token. Workspace redemption also checks the current
provider subject, and user writes check current push permission. Provider refresh and the forwarded
operation are separate calls. No live latency was measured.

Repository identity and workspace policy are rechecked on each request. Scoped tokens may be cached
by parent-token identity, exact repository set, permissions, and provider expiry. Policy decisions
are not cached. Legacy `kgh2` redemption retains its original path and does not read workspace policy.

Repository management applies only to new task workspaces. Existing legacy workspaces never initialize
or acquire workspace repository policy during renewal, restore, or sibling attachment. `kgh3` uses the
current task-workspace policy. `kgh4` adds a direct sandbox and scope binding once both services expose
repository access protocol version 2. Deploy compatible readers before enabling these writers.

Task LFS supports object transfers and the pre-push `locks/verify` check. Task sessions cannot create, list, or unlock LFS locks. Lock verification checks an existing lock before a push; it does not grant lock-management authority. Legacy sessions retain all existing lock endpoints. The distinction follows the separate verification and management operations in the [Git LFS locking API](https://github.com/git-lfs/git-lfs/blob/main/docs/api/locking.md).

Opaque-node GraphQL requests try at most eight candidate credentials per redemption. A target beyond
that budget returns `operation_not_supported`. Repository-specific REST requests select their
repository directly and remain available with larger configured policies.
