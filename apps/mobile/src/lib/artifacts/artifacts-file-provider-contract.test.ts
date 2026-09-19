// eslint-disable-next-line import/no-nodejs-modules -- vitest-only guard, runs in node, never bundled into the app
import { readFileSync } from 'node:fs';
// eslint-disable-next-line import/no-nodejs-modules -- vitest-only guard, runs in node, never bundled into the app
import { fileURLToPath } from 'node:url';
// eslint-disable-next-line import/no-nodejs-modules -- runs the CommonJS config plugin with prebuild seams in node
import { runInNewContext } from 'node:vm';

import { describe, expect, it, vi } from 'vitest';

// Contract guard for the iOS File Provider extension.
//
// Prebuild, the extension target and the Files-app walkthrough all need Xcode,
// which no host in this workflow has, so the facts the Files app depends on are
// asserted here instead: the non-UI File Provider extension point, the
// principal class, the shared app group, the target name and extension bundle
// identifier the plugin declares, and the read-only contract the extension
// implements. A rename or a plist edit fails here instead of in a device
// walkthrough.
//
// The three files agree on one contract and must be changed together:
// `targets/ArtifactsFileProvider/` (the extension), `plugins/withArtifactFileProvider.js`
// (its Xcode target, Pods integration and EAS entry) and
// `modules/artifacts-provider/ios/` (the app-side domain registration).

const APP_BUNDLE_IDENTIFIER = 'com.kilocode.kiloapp';
const TARGET_NAME = 'ArtifactsFileProvider';
const EXTENSION_BUNDLE_IDENTIFIER = `${APP_BUNDLE_IDENTIFIER}.${TARGET_NAME}`;
const APP_GROUP_IDENTIFIER = 'group.com.kilocode.kiloapp';
const EXTENSION_POINT_IDENTIFIER = 'com.apple.fileprovider-nonui';
const PRINCIPAL_CLASS = `$(PRODUCT_MODULE_NAME).${TARGET_NAME}Extension`;
const PROVIDER_MODULE_NAME = 'ArtifactsProviderModule';
const PROVIDER_MODULE_JS_NAME = 'ArtifactsProvider';
// The domain identifier the app process registers (`ArtifactsProviderModule.swift`).
const FILE_PROVIDER_DOMAIN_IDENTIFIER = 'com.kilocode.kiloapp.artifacts';
// Read-only: no write, delete or rename capability, and no write entry point.
const REFUSED_ENTRY_POINTS = ['createItem(', 'modifyItem(', 'deleteItem('];
const WRITE_CAPABILITIES = ['allowsWriting', 'allowsDeleting', 'allowsRenaming'];
// The helpers expo-widgets' `ExpoWidgetsTarget` is composed from; the plugin
// composes its target the same way instead of writing pbxproj by hand.
const XCODE_HELPERS = [
  'addBuildPhases',
  'addPbxGroup',
  'addProductFile',
  'addTargetDependency',
  'addToPbxNativeTargetSection',
  'addToPbxProjectSection',
  'addXCConfigurationList',
];

/** Read one repo file, given its path relative to `apps/mobile/`. */
const readMobileFile = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../${relativePath}`, import.meta.url)), 'utf8');

const infoPlist = readMobileFile(`targets/${TARGET_NAME}/Info.plist`);
const entitlements = readMobileFile(`targets/${TARGET_NAME}/${TARGET_NAME}.entitlements`);
const extensionSource = readMobileFile(`targets/${TARGET_NAME}/${TARGET_NAME}Extension.swift`);
const pluginSource = readMobileFile('plugins/withArtifactFileProvider.js');
const appConfigSource = readMobileFile('app.config.ts');
const providerModuleSource = readMobileFile(
  'modules/artifacts-provider/ios/ArtifactsProviderModule.swift'
);
const providerBridgeSource = readMobileFile('src/lib/artifacts/artifact-provider-native.ts');
const mirrorPathsSource = readMobileFile('src/lib/artifacts/artifact-mirror-paths.ts');
const mirrorSource = readMobileFile('src/lib/artifacts/artifact-mirror.ts');
const manifestWriterSource = readMobileFile('src/lib/artifacts/artifact-mirror-manifest.ts');
const crawlSource = readMobileFile('src/lib/artifacts/artifact-crawl.ts');
const moduleConfig: {
  platforms: string[];
  apple: { modules: string[] };
  android: { modules: string[] };
} = JSON.parse(readMobileFile('modules/artifacts-provider/expo-module.config.json'));

describe('artifacts File Provider extension contract', () => {
  it('declares the non-UI File Provider extension point', () => {
    expect(infoPlist).toContain('<key>NSExtensionPointIdentifier</key>');
    expect(infoPlist).toContain(`<string>${EXTENSION_POINT_IDENTIFIER}</string>`);
  });

  it('names the principal class the extension source declares', () => {
    expect(infoPlist).toContain('<key>NSExtensionPrincipalClass</key>');
    expect(infoPlist).toContain(`<string>${PRINCIPAL_CLASS}</string>`);
    // `NSFileProviderExtension` is deprecated; the replicated extension is the
    // shape iOS drives for a non-UI provider.
    expect(extensionSource).toContain(
      `final class ${TARGET_NAME}Extension: NSObject, NSFileProviderReplicatedExtension`
    );
  });

  it('shares the app group the app already carries and the mirror is written into', () => {
    expect(infoPlist).toContain('<key>NSExtensionFileProviderDocumentGroup</key>');
    expect(infoPlist).toContain(`<string>${APP_GROUP_IDENTIFIER}</string>`);
    expect(entitlements).toContain('<key>com.apple.security.application-groups</key>');
    expect(entitlements).toContain(`<string>${APP_GROUP_IDENTIFIER}</string>`);
    // The app group is a three-way contract: the entitlement above, the JS
    // mirror's container lookup and the extension's own reader.
    expect(mirrorPathsSource).toContain(`ARTIFACT_APP_GROUP_ID = '${APP_GROUP_IDENTIFIER}'`);
    expect(extensionSource).toContain(`appGroupIdentifier = "${APP_GROUP_IDENTIFIER}"`);
  });

  it('reads the mirror layout and manifest file the JS mirror writes', () => {
    expect(mirrorSource).toContain(`ARTIFACT_MIRROR_MANIFEST_FILE_NAME = 'manifest.json'`);
    expect(mirrorSource).toContain(`ARTIFACT_MIRROR_SESSIONS_DIR_NAME = 'sessions'`);
    expect(mirrorPathsSource).toContain(`ARTIFACT_MIRROR_DIR_NAME = 'artifacts'`);
    expect(extensionSource).toContain('manifestFileName = "manifest.json"');
    expect(extensionSource).toContain('sessionsDirectoryName = "sessions"');
    expect(extensionSource).toContain('directoryName = "artifacts"');
    // `containerURL(forSecurityApplicationGroupIdentifier:)` is the only way an
    // extension process reaches the app group container.
    expect(extensionSource).toContain('forSecurityApplicationGroupIdentifier: appGroupIdentifier');
  });

  it('reports sessions as folders and their files as items', () => {
    expect(extensionSource).toContain('contentType: .folder');
    expect(extensionSource).toContain('filename: session.title');
    expect(extensionSource).toContain('filename: file.name');
    expect(extensionSource).toContain('contentType: UTType(mimeType: file.mime) ?? .data');
  });

  it('shows the session label the mirror sanitizes into one path component', () => {
    // The extension takes the manifest label as written. That is only a valid
    // `NSFileProviderItem.filename` because the mirror sanitizes the session
    // title (free text: nullable, unbounded, may carry a path separator) before
    // it lands in the manifest, which is also the label Android shows.
    expect(manifestWriterSource).toContain('export function safeArtifactSessionName');
    expect(crawlSource).toContain(
      'safeArtifactSessionName({ id: session.id, title: session.title })'
    );
  });

  it('returns the mirrored file through the app group container', () => {
    expect(extensionSource).toContain('func fetchContents(');
    expect(extensionSource).toContain(
      'try FileManager.default.copyItem(at: source, to: destination)'
    );
  });

  it('stages every fetch under one temporary root and reaps what the system leaves', () => {
    // The system takes ownership of the URL `fetchContents` hands it — it may
    // move or delete it — so the mirrored bytes are copied out first. A staged
    // copy nothing reclaims would leak up to the per-file cap on every open, so
    // each fetch reaps the copies the system has long since taken, and
    // teardown removes the root outright.
    expect(extensionSource).toContain(
      'private static func stage(source: URL, filename: String) throws -> URL'
    );
    expect(extensionSource).toContain(
      '.appendingPathComponent("ArtifactsFileProvider", isDirectory: true)'
    );
    expect(extensionSource).toContain('reapStagedCopies(in: root)');
    expect(extensionSource).toContain('try? manager.removeItem(at: entry)');
    expect(extensionSource).toContain('try? FileManager.default.removeItem(at: Self.stagingRoot)');
  });

  it('expires the sync anchor so the system discards it and re-enumerates', () => {
    // `pageExpired` only expires an enumeration page; the anchor is what tells
    // the system to throw its anchor away and enumerate the container afresh,
    // which is what the app's `signalEnumerator(for: .rootContainer)` asks for.
    expect(extensionSource).toContain('NSFileProviderError(.syncAnchorExpired)');
    expect(extensionSource).not.toContain('NSFileProviderError(.pageExpired)');
  });

  it('shows an empty container as an empty enumeration', () => {
    // A missing manifest reads as absent and a container with no entries
    // enumerates an empty list, so an empty session is an empty folder in the
    // Files app, never an error.
    expect(extensionSource).toContain('observer.didEnumerate(mirror.items(in: container))');
    expect(extensionSource).toContain('observer.finishEnumerating(upTo: nil)');
    expect(extensionSource).toContain('case .file, .unknown:');
    expect(extensionSource).toContain('return []');
  });

  it('refuses every write-back entry point', () => {
    for (const entryPoint of REFUSED_ENTRY_POINTS) {
      expect(extensionSource).toContain(`func ${entryPoint}`);
    }
    // Foundation's `fileWriteNoPermission`, which every SDK this target builds
    // against declares: there is no write to permit, and the capabilities below
    // keep the system from asking at all.
    expect(extensionSource).toContain('CocoaError(.fileWriteNoPermission)');
    expect(extensionSource).not.toContain('NSFileProviderError(.notPermitted)');
  });

  it('declares no write capability', () => {
    // A file is readable; the root and a session folder are readable and
    // enumerable, which is what lets iOS open a session in the Files app.
    expect(extensionSource).toContain(
      'isDirectory ? [.allowsReading, .allowsContentEnumerating] : [.allowsReading]'
    );
    for (const capability of WRITE_CAPABILITIES) {
      expect(extensionSource).not.toContain(capability);
    }
  });
});

describe('artifacts File Provider target plugin contract', () => {
  const targetName = /const TARGET_NAME = '([^']+)'/.exec(pluginSource)?.[1];
  const bundleIdentifier = /const BUNDLE_IDENTIFIER = '([^']+)'/.exec(pluginSource)?.[1];
  const appGroupIdentifier = /const APP_GROUP_IDENTIFIER = '([^']+)'/.exec(pluginSource)?.[1];

  it('creates the target once across repeated non-clean prebuilds', () => {
    const targets = new Map<string, object>();
    const helpers = Object.fromEntries(XCODE_HELPERS.map(name => [name, vi.fn()]));
    helpers.addToPbxNativeTargetSection?.mockImplementation(
      (_project: object, options: { targetUuid: string; targetName: string }) => {
        const target = { uuid: options.targetUuid };
        targets.set(options.targetName, target);
        return target;
      }
    );
    const config = {
      modResults: {
        pbxTargetByName: (name: string) => targets.get(name),
        generateUuid: vi.fn(() => 'target-uuid'),
      },
    };
    type Config = typeof config;
    const pluginModule = { exports: (input: Config) => input };
    runInNewContext(pluginSource, {
      __dirname: '/mobile/plugins',
      module: pluginModule,
      require: (id: string) => {
        if (id === 'fs') {
          return { readdirSync: () => ['Info.plist', 'ArtifactsFileProviderExtension.swift'] };
        }
        if (id === 'path') {
          return { join: (...parts: string[]) => parts.join('/') };
        }
        if (id === 'expo/config-plugins') {
          return {
            withDangerousMod: (input: Config) => input,
            withXcodeProject: (input: Config, mod: (value: Config) => Config) => mod(input),
          };
        }
        const name = id.split('/').at(-1);
        return name ? { [name]: helpers[name] } : {};
      },
    });

    const first = pluginModule.exports(config);
    for (const helper of Object.values(helpers)) {
      expect(helper).toHaveBeenCalledOnce();
    }
    pluginModule.exports(first);
    for (const helper of Object.values(helpers)) {
      expect(helper).toHaveBeenCalledOnce();
    }
    expect(config.modResults.generateUuid).toHaveBeenCalledOnce();
  });

  it('targets the extension the plist and the entitlements describe', () => {
    expect(targetName).toBe(TARGET_NAME);
    const appBundleIdentifier = /bundleIdentifier: '([^']+)'/.exec(appConfigSource)?.[1];
    expect(appBundleIdentifier).toBe(APP_BUNDLE_IDENTIFIER);
    // The extension bundle id is the app's plus the target name, which is what
    // EAS signs and what the product bundle identifier build setting holds.
    expect(bundleIdentifier).toBe(`${appBundleIdentifier}.${targetName}`);
    expect(bundleIdentifier).toBe(EXTENSION_BUNDLE_IDENTIFIER);
    expect(appGroupIdentifier).toBe(APP_GROUP_IDENTIFIER);
    expect(infoPlist).toContain(`<string>${appGroupIdentifier}</string>`);
    expect(entitlements).toContain(`<string>${appGroupIdentifier}</string>`);
  });

  it('copies the committed extension sources into the Xcode project', () => {
    expect(pluginSource).toContain(
      `const SOURCE_DIRECTORY = path.join(__dirname, '..', 'targets', TARGET_NAME);`
    );
    expect(pluginSource).toContain('copyFileSync');
    expect(pluginSource).toContain('withDangerousMod');
  });

  it('composes the target from the helpers expo-widgets uses', () => {
    for (const helper of XCODE_HELPERS) {
      expect(pluginSource).toContain(`expo-widgets/plugin/build/ios/xcode/${helper}`);
    }
    expect(pluginSource).toContain('withXcodeProject');
    expect(pluginSource).toContain('Embed Foundation Extensions');
  });

  it('links the extension target in the Podfile', () => {
    // The Podfile entry is a template literal in the plugin, so the placeholder
    // is assembled here instead of sitting in a plain string.
    expect(pluginSource).toContain(['target "', '$', '{TARGET_NAME}" do'].join(''));
  });

  it('carries the extension and its app group into the EAS app extensions', () => {
    expect(pluginSource).toContain('eas');
    expect(pluginSource).toContain('appExtensions');
    expect(pluginSource).toContain(
      "'com.apple.security.application-groups': [APP_GROUP_IDENTIFIER]"
    );
    expect(pluginSource).toContain('bundleIdentifier: BUNDLE_IDENTIFIER');
  });

  it('adds no write capability to the target', () => {
    for (const capability of WRITE_CAPABILITIES) {
      expect(pluginSource).not.toContain(capability);
    }
    expect(appConfigSource).toContain("'./plugins/withArtifactFileProvider'");
  });
});

describe('artifacts provider iOS module contract', () => {
  it('registers the apple module the expo module config names', () => {
    expect(moduleConfig.platforms).toEqual(['apple', 'android']);
    expect(moduleConfig.apple.modules).toEqual([PROVIDER_MODULE_NAME]);
    expect(providerModuleSource).toContain(`public final class ${PROVIDER_MODULE_NAME}: Module`);
    expect(providerModuleSource).toContain(`Name("${PROVIDER_MODULE_JS_NAME}")`);
  });

  it('exposes exactly the entry points the JS bridge calls', () => {
    expect(providerBridgeSource).toContain('registerArtifactsProviderDomain');
    expect(providerBridgeSource).toContain('notifyArtifactsChanged');
    expect(providerModuleSource).toContain('Function("registerArtifactsProviderDomain")');
    expect(providerModuleSource).toContain('Function("notifyArtifactsChanged")');
  });

  it('registers the domain idempotently and signals the root after a sync', () => {
    expect(providerModuleSource).toContain(
      `domainIdentifier = "${FILE_PROVIDER_DOMAIN_IDENTIFIER}"`
    );
    // The location's name in the Files app, matching the extension's bundle.
    expect(providerModuleSource).toContain('domainDisplayName = "Kilo"');
    expect(infoPlist).toContain('<string>Kilo</string>');
    // Registration reads the registered domains first and skips the add when
    // this one is already there, so a cold start, a sign-in and a foreground
    // refresh can all call it without a duplicate-registration error.
    //
    // The File Provider domain list is `getDomainsWithCompletionHandler(_:)` —
    // the Swift name of `+getDomainsWithCompletionHandler:` in
    // `NSFileProviderManager.h`. The SDK declares no `getDomains` member, so a
    // bare `NSFileProviderManager.getDomains { ... }` is a compile error that
    // only surfaces on a macOS runner; and the header sits inside
    // `NS_ASSUME_NONNULL_BEGIN`, so the list is non-optional and a conditional
    // binding around it would not compile either.
    expect(providerModuleSource).toContain(
      'NSFileProviderManager.getDomainsWithCompletionHandler { domains, error in'
    );
    expect(providerModuleSource).not.toContain('NSFileProviderManager.getDomains {');
    expect(providerModuleSource).not.toContain('NSFileProviderManager.getDomains(');
    expect(providerModuleSource).not.toContain('guard let domains');
    expect(providerModuleSource).toContain('NSFileProviderManager.add(domain)');
    expect(providerModuleSource).not.toContain('domainAlreadyExists');
    expect(providerModuleSource).toContain('signalEnumerator(for: .rootContainer)');
  });
});
