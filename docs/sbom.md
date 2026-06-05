# Software Bill of Materials (SBOM)

We generate SBOMs automatically as part of the release flow so every shipped artifact has a
traceable, verifiable inventory of its components. This complements CodeQL, Dependabot, and
Trufflehog — none of which emit an SBOM.

All SBOMs are **CycloneDX JSON**, generated with [syft](https://github.com/anchore/syft) via the
official `anchore/sbom-action`. SBOMs are **never committed** to the repo.

## What we generate, where it lives, and when

| Target | Tooling | When | Stored as |
|---|---|---|---|
| **Source dependency tree** (repo-wide pnpm graph) | `.github/workflows/sbom.yml` | push to `main`, weekly cron, manual dispatch | Retained CI **workflow artifact** (`cloud-sbom-<sha>`) |
| **KiloClaw container image** (OS packages + Go + Node + OpenClaw + npm) | `.github/workflows/deploy-kiloclaw.yml` | at image **build time** (only when content changes) | Signed **attestation in GHCR**, bound to the image digest |

The image SBOM uses the richest source available — the built image — so it captures the OS-package
and multi-ecosystem footprint that a lockfile-only SBOM misses. The image step is gated to the
build path: the content-hash skip logic means an unchanged image keeps the attestation produced when
its content was last built, so we never pull a large unchanged image on a no-op deploy.

## Verifying an image SBOM attestation

```sh
gh attestation verify oci://ghcr.io/kilo-org/kiloclaw@<digest> --owner kilo-org
```

## Reproducing the source SBOM locally

syft reads `pnpm-lock.yaml` directly (no `pnpm install` needed) and picks up the repo's
`.syft.yaml` exclusions automatically:

```sh
syft scan dir:. -o cyclonedx-json=cloud-sbom.cyclonedx.json
```

## Other repos (kilocode, abuse) — bun caveat

syft cannot parse `bun.lock` (its lock cataloger only handles `package-lock.json`, `yarn.lock`, and
`pnpm-lock.yaml`). For bun repos you must scan an **installed** tree and explicitly enable the
package cataloger (it is tagged `image,installed` and is off by default for directory scans):

```sh
bun install --frozen-lockfile
syft scan dir:. \
  --select-catalogers '+javascript-package-cataloger' \
  --exclude './.git/**' --exclude './**/.turbo/**' --exclude './**/dist/**' \
  -o cyclonedx-json=sbom.cyclonedx.json
```

## Follow-ups (not yet implemented)

- **Vulnerability scanning** — pair each SBOM with Grype and upload SARIF to the GitHub Security tab,
  surfacing OS-package and shipped-image CVEs that Dependabot/CodeQL don't see.
- **Additional container images** — extend the `deploy-kiloclaw.yml` attestation pattern to gastown,
  cloud-agent, and other images once each has a registry-push path to attest against.
