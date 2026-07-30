# mobile: in-app cloud-agent session creation needs a GitHub integration

Symptom: the new-session screen cannot create a cloud-agent session on a fresh local stack — the repository section is empty and the flow dead-ends.

Cause: the test account has no GitHub integration, so `listGitHubRepositories` returns nothing.

Fix: run the flow as a user account that already has the GitHub integration set up, or copy that integration to the test account. If no account on the stack has one, ask the human to set up the GitHub integration for an account — the run is blocked on human action until they do. A blocked cloud-agent create on a fresh stack is a test-environment limitation, not a product failure.
