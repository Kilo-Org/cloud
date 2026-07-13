# Store metadata

Play Store listing metadata for the Android build of Kilo App, using the
[fastlane `supply` layout](https://docs.fastlane.tools/actions/supply/#metadata-structure)
so it can be consumed directly by `fastlane supply` or copied into the Play
Console if we're not running fastlane in CI yet.

## Changelogs

`android/en-US/changelogs/<versionCode>.txt` holds the Play Store "What's new"
text for a given Android `versionCode` (the build number shown in EAS/Play
Console). Each file should be plain, user-facing release notes (no internal
jargon, no PR/issue links) and stay within Google's 500-character limit per
locale.

Android build numbers are tracked via the `kilo-app-release/<date>-<sha>` tags
pushed by `.github/workflows/kilo-app-release.yml`. To find the commit range
for a given build, diff the tag for that build against the tag for the
previous build, filtered to the paths the release workflow watches
(`apps/mobile/`, `packages/trpc/`, `pnpm-lock.yaml`):

```bash
git log --oneline <previous-tag>..<this-tag> -- apps/mobile packages/trpc pnpm-lock.yaml
```
