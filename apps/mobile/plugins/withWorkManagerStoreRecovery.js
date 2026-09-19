const { withAndroidManifest, withAppBuildGradle, withDangerousMod } = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

const WORK_DEPENDENCY_MARKER = 'kilo-work-manager-store-recovery';
const WORK_RUNTIME_DEPENDENCY = "implementation 'androidx.work:work-runtime:2.8.1'";
const MAIN_APPLICATION_RELATIVE_PATH = [
  'app',
  'src',
  'main',
  'java',
  'com',
  'kilocode',
  'kiloapp',
  'MainApplication.kt',
];

// A data directory moved by a device migration or a backup restore can leave
// WorkManager's SQLite store present but unopenable (SQLITE_CANTOPEN). The
// library's own startup check (ForceStopRunnable) then throws
// IllegalStateException on its background thread and the app crash-loops
// behind the launcher icon on every launch until the data is cleared —
// emulator-5554 hit exactly that (14:48:42, 14:49:34, 14:53:28 FATAL launches
// in one round) after the harness restored its frozen signed-in app data.
//
// Two changes make the launch survive that state:
//  1. WorkManager no longer initializes eagerly through androidx.startup.
//     MainApplication gets the chance to rebuild an unopenable store first;
//     the library then initializes on demand through Configuration.Provider.
//  2. Before anything can initialize WorkManager, MainApplication health-checks
//     the store: an unopenable workdb (plus journal/wal/shm sidecars) is
//     deleted and rebuilt, and a stale sidecar without its database is
//     cleaned. Background work is reschedulable, so losing the store beats an
//     unusable launch.

/** Kotlin injected into the generated MainApplication.kt (idempotent). */
const CLASS_DECLARATION = 'class MainApplication : Application(), ReactApplication {';
const CLASS_DECLARATION_PATCHED =
  'class MainApplication : Application(), ReactApplication, androidx.work.Configuration.Provider {';
const IMPORT_ANCHOR = 'import android.content.res.Configuration';
const IMPORT_PATCH = `import android.content.res.Configuration
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteException
import android.util.Log

import java.io.File`;
const ON_CREATE_ANCHOR = `  override fun onCreate() {
    super.onCreate()`;
const ON_CREATE_PATCH = `  override fun onCreate() {
    super.onCreate()

    recoverUnopenableWorkManagerStore()`;
const ON_CONFIGURATION_CHANGED_ANCHOR = '  override fun onConfigurationChanged(newConfig: Configuration) {';
const RECOVERY_MEMBERS = `  // Fully qualified on purpose: \`Configuration\` would collide with
  // android.content.res.Configuration, which onConfigurationChanged uses.
  override fun getWorkManagerConfiguration(): androidx.work.Configuration =
    androidx.work.Configuration.Builder().build()

  /**
   * A data directory moved by a device migration or a backup restore can leave
   * WorkManager's SQLite store present but unopenable (SQLITE_CANTOPEN). The
   * library's own startup check (\`ForceStopRunnable\`) then throws
   * \`IllegalStateException\` on its background thread and the app crash-loops
   * behind the launcher icon on every launch until the data is cleared. The
   * store only holds reschedulable background work, so an unopenable store is
   * deleted and rebuilt instead of crashing the launch.
   */
  private fun recoverUnopenableWorkManagerStore() {
    val dir = noBackupFilesDir
    val store = File(dir, WORK_MANAGER_DB)
    if (!store.isFile) {
      // A sidecar without its database cannot be hot journal state, and a
      // broken one can block the fresh store from ever being created.
      removeWorkManagerStoreFiles(dir, rebuiltIfAny = false)
      return
    }
    try {
      SQLiteDatabase.openDatabase(store.absolutePath, null, SQLiteDatabase.OPEN_READWRITE).use { }
      return
    } catch (e: SQLiteException) {
      // The store exists but cannot be opened; rebuild it below.
    }
    removeWorkManagerStoreFiles(dir, rebuiltIfAny = true)
  }

  private fun removeWorkManagerStoreFiles(dir: File, rebuiltIfAny: Boolean) {
    var removed = false
    for (name in WORK_MANAGER_DB_FILES) {
      try {
        removed = File(dir, name).delete() || removed
      } catch (e: SecurityException) {
        // Try the remaining sidecar files; the outcome is reported below.
      }
    }
    if (removed) {
      if (rebuiltIfAny) {
        Log.i(TAG, "Rebuilt an unopenable WorkManager store; background work restarts empty")
      } else {
        Log.i(TAG, "Removed a stale WorkManager store sidecar")
      }
    } else if (rebuiltIfAny) {
      Log.w(TAG, "The WorkManager store is unopenable and could not be rebuilt")
    }
  }

  companion object {
    private const val TAG = "MainApplication"
    private const val WORK_MANAGER_DB = "androidx.work.workdb"
    private val WORK_MANAGER_DB_FILES =
      arrayOf(WORK_MANAGER_DB, "$WORK_MANAGER_DB-journal", "$WORK_MANAGER_DB-wal", "$WORK_MANAGER_DB-shm")
  }

`;
const RECOVERY_MEMBERS_IDEMPOTENCE_ANCHOR = 'recoverUnopenableWorkManagerStore()';

function patchMainApplication(contents) {
  if (contents.includes(RECOVERY_MEMBERS_IDEMPOTENCE_ANCHOR)) {
    return contents;
  }
  if (!contents.includes(CLASS_DECLARATION)) {
    throw new Error('MainApplication.kt template changed: class declaration anchor missing');
  }
  if (!contents.includes(IMPORT_ANCHOR)) {
    throw new Error('MainApplication.kt template changed: import anchor missing');
  }
  if (!contents.includes(ON_CREATE_ANCHOR)) {
    throw new Error('MainApplication.kt template changed: onCreate anchor missing');
  }
  if (!contents.includes(ON_CONFIGURATION_CHANGED_ANCHOR)) {
    throw new Error('MainApplication.kt template changed: onConfigurationChanged anchor missing');
  }
  let patched = contents
    .replace(IMPORT_ANCHOR, IMPORT_PATCH)
    .replace(CLASS_DECLARATION, CLASS_DECLARATION_PATCHED)
    .replace(ON_CREATE_ANCHOR, ON_CREATE_PATCH)
    .replace(ON_CONFIGURATION_CHANGED_ANCHOR, RECOVERY_MEMBERS + ON_CONFIGURATION_CHANGED_ANCHOR);
  if (patched === contents) {
    throw new Error('MainApplication.kt patch did not apply');
  }
  return patched;
}

function withWorkManagerStoreMainApplication(config) {
  return withDangerousMod(config, [
    'android',
    cfg => {
      const mainApplicationPath = path.join(
        cfg.modRequest.platformProjectRoot,
        ...MAIN_APPLICATION_RELATIVE_PATH
      );
      if (!fs.existsSync(mainApplicationPath)) {
        throw new Error(
          `MainApplication.kt is missing at ${mainApplicationPath}; the Android project was not generated`
        );
      }
      const contents = fs.readFileSync(mainApplicationPath, 'utf8');
      fs.writeFileSync(mainApplicationPath, patchMainApplication(contents));
      return cfg;
    },
  ]);
}

/** Puts work-runtime on the app module's compile classpath. */
function withWorkManagerDependency(config) {
  return withAppBuildGradle(config, cfg => {
    if (cfg.modResults.contents.includes(WORK_DEPENDENCY_MARKER)) {
      return cfg;
    }
    cfg.modResults.contents += `
// ${WORK_DEPENDENCY_MARKER}: MainApplication rebuilds an unopenable
// WorkManager store at launch, so the library must be on the app module's
// compile classpath, not only transitive through react-native-android-widget.
dependencies {
    ${WORK_RUNTIME_DEPENDENCY}
}
`;
    return cfg;
  });
}

/**
 * Removes WorkManager's eager androidx.startup initializer so the library only
 * initializes on demand, after MainApplication has rebuilt an unopenable store.
 */
function withWorkManagerStoreManifest(config) {
  return withAndroidManifest(config, cfg => {
    const manifest = cfg.modResults.manifest;
    manifest.$['xmlns:tools'] = 'http://schemas.android.com/tools';
    const application = manifest.application?.[0];
    if (!application) {
      throw new Error('Android manifest has no <application> node');
    }
    // Providers live inside <application>; a manifest-level one fails AAPT.
    const providers = (application.provider ??= []);
    const name = 'androidx.startup.InitializationProvider';
    let provider = providers.find(entry => entry.$?.['android:name'] === name);
    if (!provider) {
      provider = {
        $: {
          'android:name': name,
          'android:authorities': '${applicationId}.androidx-startup',
          'android:exported': 'false',
          'tools:node': 'merge',
        },
        'meta-data': [],
      };
      providers.push(provider);
    }
    const metadata = (provider['meta-data'] ??= []);
    const initializer = 'androidx.work.WorkManagerInitializer';
    if (!metadata.some(entry => entry.$?.['android:name'] === initializer)) {
      metadata.push({
        $: {
          'android:name': initializer,
          'android:value': 'androidx.startup',
          'tools:node': 'remove',
        },
      });
    }
    return cfg;
  });
}

module.exports = function withWorkManagerStoreRecovery(config) {
  return withWorkManagerStoreManifest(
    withWorkManagerDependency(withWorkManagerStoreMainApplication(config))
  );
};
