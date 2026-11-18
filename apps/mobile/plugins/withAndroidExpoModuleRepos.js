const { withProjectBuildGradle } = require('expo/config-plugins');

const MARKER = 'kilo-prebuilt-expo-modules';

/**
 * Prebuilt Expo modules ship as AARs inside each package, and
 * expo-modules-autolinking serves them from a `local-maven-repo` file
 * repository per package. Their coordinates (`*:expo.modules.*`) exist nowhere
 * else, so every remote repository answers 404 for them.
 *
 * Gradle treats a 404 as "keep looking" but any other HTTP error as fatal. When
 * a remote repository is consulted first and rate-limits the lookup, all 35
 * modules fail at once and the build dies even though the AARs are on disk.
 * Maven Central returned 429 to an EAS builder on 2026-09-03 and did exactly
 * that.
 *
 * Excluding the coordinates from every remote repository keeps the lookups on
 * disk, where they always resolve.
 */
const REPOSITORY_FILTER = `
// ${MARKER}: prebuilt Expo module AARs live only in the per-package
// local-maven-repo directories. Remote repositories 404 for them, and a
// rate-limited 404 (429) is fatal to the whole build, so never ask remotely.
allprojects {
  repositories.all { repo ->
    if (repo instanceof org.gradle.api.artifacts.repositories.MavenArtifactRepository
        && repo.url.scheme != 'file') {
      repo.content { content ->
        content.excludeModuleByRegex('.*', 'expo\\\\.modules\\\\..*')
      }
    }
  }
}
`;

function withAndroidExpoModuleRepos(config) {
  return withProjectBuildGradle(config, config => {
    if (config.modResults.language !== 'groovy') {
      throw new Error('withAndroidExpoModuleRepos supports only Groovy build.gradle');
    }
    if (config.modResults.contents.includes(MARKER)) return config;
    config.modResults.contents += REPOSITORY_FILTER;
    return config;
  });
}

module.exports = withAndroidExpoModuleRepos;
