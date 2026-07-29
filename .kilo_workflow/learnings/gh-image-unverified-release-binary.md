# gh-image must be source-reviewed and checksum-pinned before cookie access

Symptom: the screenshot-upload workflow installed a third-party release binary and then let it
read a full-account GitHub `user_session` cookie. Pinning only the mutable release tag did not
prove that agents would execute the code reviewed in this PR.

Cause: GitHub has no public attachment-upload API. `gh-image` v1.2.0 implements GitHub's private
web upload using browser authentication, but `gh extension install --pin` downloads and executes
the upstream binary without a repository-owned integrity check.

Fix: use `upload-pr-attachment.sh`. It permits only the reviewed v1.2.0 release assets whose
SHA-256 digests are committed in the script, verifies the digest before first execution and on
every cached execution, and discards `GH_SESSION_TOKEN`. Its interface accepts exactly one
non-symlink PNG/JPEG/GIF/WebP under GitHub's 10 MB limit plus an explicit `owner/repo`, so the
upstream token-export and arbitrary-file paths are unreachable.

Security review, 2026-07-28:

- Reviewed source tag `v1.2.0`, commit `44f4b93ecbbe22de6c45fa2f62f519aee564ca8c`,
  including all non-test Go code, tests, the dependency manifest, release configuration, and
  security policy.
- Session-cookie values stay in memory and are attached only to hard-coded `https://github.com`
  requests. The uploaded file goes separately to the presigned storage URL without GitHub cookies;
  finalization is restricted to a root-relative GitHub path. No telemetry or unrelated network
  destination exists in the reviewed source.
- The binary can deliberately print the session through `extract-token` or accept it through
  `--token`/`GH_SESSION_TOKEN`; the repository wrapper exposes none of those arguments and clears
  the environment token.
- The only direct external package is `browserutils/kooky` v0.2.10 (source commit
  `0d54a50c33ecea7d703d4edda7571c3559dc485d`), used to read encrypted browser stores. Its reviewed
  source performs local browser/keychain access and no network calls. The dependency manifest was
  checked against GitHub's Advisory Database: current findings exist in `x/crypto` and `x/net`,
  but the imported paths use only `hkdf`, `pbkdf2`, and `publicsuffix`, not the affected SSH or
  HTML-parser code.
- Upstream test, lint, and release jobs passed on the reviewed commit. The release workflow's
  third-party actions use major-version tags rather than commit SHAs, so the build chain is not
  independently reproducible; the committed release digests bind workflow execution to the exact
  binaries exercised here. Any version bump requires a fresh source, dependency,
  behavior, and digest review in a PR.
- Residual risk: the tool necessarily gives a third-party binary a full-account session cookie and
  relies on an undocumented GitHub endpoint. A compromised browser session or an undiscovered flaw
  in the pinned binary retains that blast radius. Use only a logged-in account that needs write
  access to the target repository; never use this in CI or persist a session token.
