/* eslint-disable eslint-plugin-import/no-nodejs-modules, eslint-plugin-unicorn/prefer-module -- this test runs the prebuild plugin against a parsed pbxproj, the only place the extension's file-reference resolution is observable under vitest */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

const requireCjs = createRequire(__filename);
const { IOSConfig } = requireCjs('expo/config-plugins') as {
  IOSConfig: { XcodeUtils: { getPbxproj(projectRoot: string): unknown } };
};
const withNotificationFocusFilter = requireCjs(
  join(__dirname, '../../plugins/withNotificationFocusFilter.js')
) as (config: unknown, props?: unknown) => Record<string, unknown>;

const TARGET_NAME = 'NotificationServiceExtension';
const APP_ROOT = join(__dirname, '../..');
const SOURCE_NAMES = ['NotificationService.swift', 'NotificationFocusFilterStorage.swift'];

/**
 * The smallest pbxproj the plugin's mods read: one app target with its product
 * and build configuration, the main group, and a Products group. The extension
 * target, its group, and its build phases are what the plugin adds.
 */
const MINIMAL_PBXPROJ = `// !$*UTF8*$!
{
	archiveVersion = 1;
	classes = {
	};
	objectVersion = 46;
	objects = {

/* Begin PBXBuildFile section */
		100000000000000000000009 /* Kilo.app in Products */ = {isa = PBXBuildFile; fileRef = 100000000000000000000001 /* Kilo.app */; };
/* End PBXBuildFile section */

/* Begin PBXFileReference section */
		100000000000000000000001 /* Kilo.app */ = {isa = PBXFileReference; explicitFileType = wrapper.application; includeInIndex = 0; path = Kilo.app; sourceTree = BUILT_PRODUCTS_DIR; };
/* End PBXFileReference section */

/* Begin PBXGroup section */
		100000000000000000000002 = {
			isa = PBXGroup;
			children = (
			);
			sourceTree = "<group>";
		};
		100000000000000000000003 /* Products */ = {
			isa = PBXGroup;
			children = (
				100000000000000000000001 /* Kilo.app */,
			);
			name = Products;
			sourceTree = "<group>";
		};
/* End PBXGroup section */

/* Begin XCBuildConfiguration section */
		100000000000000000000008 /* Release */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
			};
			name = Release;
		};
/* End XCBuildConfiguration section */

/* Begin PBXNativeTarget section */
		100000000000000000000004 /* Kilo */ = {
			isa = PBXNativeTarget;
			buildConfigurationList = 100000000000000000000005 /* Build configuration list for PBXNativeTarget "Kilo" */;
			buildPhases = (
			);
			buildRules = (
			);
			dependencies = (
			);
			name = Kilo;
			productName = Kilo;
			productReference = 100000000000000000000001 /* Kilo.app */;
			productType = "com.apple.product-type.application";
		};
/* End PBXNativeTarget section */

/* Begin PBXProject section */
		100000000000000000000006 /* Project object */ = {
			isa = PBXProject;
			attributes = {
				TargetAttributes = {
				};
			};
			buildConfigurationList = 100000000000000000000007 /* Build configuration list for PBXProject "Kilo" */;
			compatibilityVersion = "Xcode 9.3";
			developmentRegion = en;
			hasScannedForEncodings = 0;
			knownRegions = (
				en,
				Base,
			);
			mainGroup = 100000000000000000000002;
			productRefGroup = 100000000000000000000003 /* Products */;
			projectDirPath = "";
			projectRoot = "";
			targets = (
				100000000000000000000004 /* Kilo */,
			);
		};
/* End PBXProject section */

/* Begin XCConfigurationList section */
		100000000000000000000005 /* Build configuration list for PBXNativeTarget "Kilo" */ = {
			isa = XCConfigurationList;
			buildConfigurations = (
			);
			defaultConfigurationIsVisible = 0;
			defaultConfigurationName = Release;
		};
		100000000000000000000007 /* Build configuration list for PBXProject "Kilo" */ = {
			isa = XCConfigurationList;
			buildConfigurations = (
			);
			defaultConfigurationIsVisible = 0;
			defaultConfigurationName = Release;
		};
/* End XCConfigurationList section */
	};
	rootObject = 100000000000000000000006 /* Project object */;
}
`;

const work = mkdtempSync(join(tmpdir(), 'notification-focus-filter-target-'));
afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

function unquote(value: string): string {
  return value.replace(/^"(.*)"$/s, '$1');
}

/** The typed slice of the parsed project this test reads. */
type PbxObjects = {
  PBXBuildFile: Record<string, { fileRef: string }>;
  PBXFileReference: Record<string, { path: string; sourceTree: string }>;
  PBXGroup: Record<string, { name?: string; path?: string; children?: { value: string }[] }>;
  PBXNativeTarget: Record<
    string,
    { name: string; buildPhases: { value: string; comment: string }[] }
  >;
  PBXSourcesBuildPhase: Record<string, { files: { value: string }[] }>;
};

/** The first real member of a pbxproj section that matches; comment keys are strings. */
function findSectionMember<T extends object>(
  section: Record<string, unknown>,
  isMatch: (member: T) => boolean
): { uuid: string; member: T } | undefined {
  const found = Object.entries(section).find(
    ([uuid, value]) =>
      !uuid.endsWith('_comment') &&
      typeof value === 'object' &&
      value !== null &&
      isMatch(value as T)
  );
  return found ? { uuid: found[0], member: found[1] as T } : undefined;
}

/** A value the generated project guarantees; a missing one fails with its name. */
function required<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw new Error(`${name} is missing from the generated project`);
  }
  return value;
}

async function prebuild() {
  const iosRoot = join(work, 'ios');
  const projectDirectory = join(iosRoot, 'Kilo.xcodeproj');
  mkdirSync(projectDirectory, { recursive: true });
  writeFileSync(join(projectDirectory, 'project.pbxproj'), MINIMAL_PBXPROJ);

  const config = withNotificationFocusFilter(
    {
      name: 'Kilo',
      version: '1.0.11',
      ios: {
        bundleIdentifier: 'com.kilocode.kiloapp',
        version: '1.0.11',
        buildNumber: '11',
        appleTeamId: 'ABCDE12345',
      },
      extra: {},
    },
    { appGroupIdentifier: 'group.com.kilocode.kiloapp' }
  );
  const mods = config.mods as {
    ios: { dangerous: (value: unknown) => unknown; xcodeproj: (value: unknown) => unknown };
  };
  const modRequest = { projectRoot: APP_ROOT, platformProjectRoot: iosRoot };

  // The copy phase runs first in a real prebuild; it is what puts the Swift
  // files where the project's references have to point.
  await mods.ios.dangerous({ ...config, modRequest });

  const project = IOSConfig.XcodeUtils.getPbxproj(work);
  await mods.ios.xcodeproj({ ...config, modResults: project, modRequest });
  return { iosRoot, project: project as { hash: { project: { objects: PbxObjects } } } };
}

describe('withNotificationFocusFilter', () => {
  it('resolves the extension sources inside the extension directory', async () => {
    const { iosRoot, project } = await prebuild();
    const objects = project.hash.project.objects;

    // The Sources phase must attach to the extension, not fall back to the app
    // target (`addBuildPhase` does that when the target uuid is undefined).
    const target = required(
      findSectionMember<PbxObjects['PBXNativeTarget'][string]>(
        objects.PBXNativeTarget,
        member => member.name === TARGET_NAME
      ),
      `the ${TARGET_NAME} target`
    );
    const phaseReference = required(
      target.member.buildPhases.find(phase => phase.comment === 'Sources'),
      `the ${TARGET_NAME} Sources build phase`
    );
    const phase = required(
      objects.PBXSourcesBuildPhase[phaseReference.value],
      `the Sources build phase of ${TARGET_NAME}`
    );

    // The extension's group carries the target name as its path, and the
    // Sources-phase file references are its children. Xcode resolves a
    // `"<group>"` file reference against the containing group's path, so a
    // bare basename here resolves to `${TARGET_NAME}/<basename>` from the
    // project root — the directory the copy phase writes into below.
    const group = required(
      findSectionMember<PbxObjects['PBXGroup'][string]>(
        objects.PBXGroup,
        member => member.name === TARGET_NAME
      ),
      `the ${TARGET_NAME} group`
    );
    expect(group.member.path).toBe(TARGET_NAME);
    const groupChildren = new Set((group.member.children ?? []).map(child => child.value));

    const resolved: string[] = [];
    for (const buildFile of phase.files) {
      const buildEntry = required(objects.PBXBuildFile[buildFile.value], buildFile.value);
      const reference = required(objects.PBXFileReference[buildEntry.fileRef], buildEntry.fileRef);
      expect(unquote(reference.sourceTree)).toBe('<group>');
      expect(groupChildren.has(buildEntry.fileRef), `${reference.path} group membership`).toBe(
        true
      );
      resolved.push(`${TARGET_NAME}/${unquote(reference.path)}`);
    }

    expect(resolved.toSorted()).toEqual(
      SOURCE_NAMES.map(name => `${TARGET_NAME}/${name}`).toSorted()
    );
    for (const relative of resolved) {
      expect(existsSync(join(iosRoot, relative)), relative).toBe(true);
    }
  });
});
