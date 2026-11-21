# Cloud Agent GitHub capabilities

The token service accepts container-bound legacy `kgh2` and task-scoped `kgh3` capabilities. Existing callers without `taskScope` keep legacy issuance, credential selection, and request policy. Task issuance and redemption reject provided credentials with `provided_token_not_supported`.

Deploy this compatible reader before Cloud Agent starts issuing task capabilities. Existing workspaces need no migration. Once task capabilities exist, rollback must retain support for both formats.

Task verification performs live repository identity checks before forwarding authorization. Each redemption permits at most 16 distinct verification lookups, including the task repository. Repeated GraphQL selections share one lookup. Excessive selections fail before network access.

The local upstream-call-count regression measures one repository lookup per request and one additional scoped-token exchange for GitHub App user credentials. These are verification and narrowing calls; credential refresh and the forwarded operation are separate. Two ordinary user-authorized requests therefore perform four such calls. No live latency measurement was performed.

Repository identity is checked again on each request because provider ownership and access can change while a sealed capability remains valid. The service does not cache that authority across requests. Scoped-token caching is deferred; it requires a separate expiry, identity, and revocation design.

Task LFS supports object transfers and the pre-push `locks/verify` check. Task sessions cannot create, list, or unlock LFS locks. Lock verification checks an existing lock before a push; it does not grant lock-management authority. Legacy sessions retain all existing lock endpoints. The distinction follows the separate verification and management operations in the [Git LFS locking API](https://github.com/git-lfs/git-lfs/blob/main/docs/api/locking.md).
