package expo.modules.kilosystemsearch

import android.app.appsearch.AppSearchBatchResult
import android.app.appsearch.AppSearchManager
import android.app.appsearch.AppSearchResult
import android.app.appsearch.AppSearchSchema
import android.app.appsearch.AppSearchSession
import android.app.appsearch.BatchResultCallback
import android.app.appsearch.GenericDocument
import android.app.appsearch.PackageIdentifier
import android.app.appsearch.PutDocumentsRequest
import android.app.appsearch.RemoveByDocumentIdRequest
import android.app.appsearch.SearchResult
import android.app.appsearch.SearchSpec
import android.app.appsearch.SetSchemaRequest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import androidx.annotation.RequiresApi
import androidx.appsearch.app.AppSearchBatchResult as JetpackBatchResult
import androidx.appsearch.app.AppSearchSchema as JetpackSchema
import androidx.appsearch.app.AppSearchSession as JetpackSession
import androidx.appsearch.app.GenericDocument as JetpackDocument
import androidx.appsearch.app.PutDocumentsRequest as JetpackPutRequest
import androidx.appsearch.app.RemoveByDocumentIdRequest as JetpackRemoveRequest
import androidx.appsearch.app.SearchSpec as JetpackSearchSpec
import androidx.appsearch.app.SetSchemaRequest as JetpackSetSchemaRequest
import androidx.appsearch.localstorage.LocalStorage
import androidx.appsearch.util.DocumentIdUtil
import com.google.common.util.concurrent.ListenableFuture
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutionException
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.security.MessageDigest
import java.util.function.Consumer

private const val NAMESPACE = "kilo"
private const val TAG = "KiloSystemSearch"
private const val SCHEMA_TYPE = "KiloSystemSearchEntity"
private const val DATABASE_NAME = "kilo-system-search"
private const val PREFERENCES_NAME = "kilo-system-search"
private const val PENDING_ROUTE_KEY = "kilo-system-search-pending-route"
private const val PROPERTY_ID = "id"
private const val PROPERTY_TITLE = "title"
private const val PROPERTY_DESCRIPTION = "description"
private const val PROPERTY_KEYWORDS = "keywords"
private const val PROPERTY_FINGERPRINT = "fingerprint"
private const val PROPERTY_ROUTE = "route"
private const val APP_SCHEME_PREFIX = "kiloapp://"
private const val GLOBAL_SEARCH_PACKAGE = "com.google.android.googlequicksearchbox"
private const val PAGE_SIZE = 100
private const val TIMEOUT_SECONDS = 30L
private const val TIMEOUT_MESSAGE = "The system search index did not respond."

/**
 * One indexed entity, as JavaScript hands it across.
 *
 * `route` is `SystemSearchDocument.route` in `src/lib/native-system-search.ts`:
 * the entry's own `kiloapp://` link. It is the value the pending slot carries,
 * so the JS side receives one identifier no matter which platform delivered the
 * tap. The record id remains the fallback for a bundle that predates the field.
 */
class SystemSearchRecord : Record {
  @Field val id: String = ""
  @Field val title: String = ""
  @Field val description: String = ""
  @Field val keywords: List<String> = emptyList()
  @Field val fingerprint: String = ""
  @Field val route: String = ""
}

/** A record in the shape the index stores, independent of the AppSearch build in use. */
private data class IndexedDocument(
  val id: String,
  val title: String,
  val description: String,
  val keywords: List<String>,
  val fingerprint: String,
  val route: String
)

/** One stored document, as the index answers with it. */
private data class StoredDocument(
  val id: String,
  val fingerprint: String,
  val route: String
)

/**
 * The subset of an AppSearch session this module uses, so the platform store
 * (API 31+) and the Jetpack local store (below 31) can both back it.
 */
private interface SearchBackend {
  fun put(documents: List<IndexedDocument>)
  fun remove(ids: List<String>)
  fun clear()

  /** Every stored document: the ledger the JS side diffs against. */
  fun stored(): List<StoredDocument>

  /** Releases the AppSearch session and any thread this backend owns. */
  fun close()
}

class KiloSystemSearchModule : Module() {
  // Created on the first call so the database only opens when the app indexes
  // something, and kept in a field so `OnDestroy` can close a backend that was
  // opened without opening one that was never needed. `appContext.reactContext`
  // is the long-lived application context.
  private var openedBackend: SearchBackend? = null

  private val backend: SearchBackend
    get() = openedBackend ?: openBackend().also { openedBackend = it }

  private fun openBackend(): SearchBackend {
    val context = appContext.reactContext?.applicationContext
      ?: throw CodedException("A React context is required to use the system search index.")
    return createSearchBackend(context)
  }

  // The launching Intent is the tap on a cold start, and it is delivered once:
  // every later delivery comes from `OnNewIntent` instead.
  private var launchIntentRead = false

  // Serializes the single-shot slot's write against its read-and-clear: the
  // write runs on the main thread that delivers the Intent, the read on the
  // module queue that answers JavaScript.
  private val pendingRouteLock = Any()

  override fun definition() = ModuleDefinition {
    Name("KiloSystemSearch")

    // A tap on one of our results in the phone's search surface reaches the app
    // as an Intent carrying the picked entry's identifier. The JS side already
    // consumes that identifier through the single-shot slot below, so a tap
    // while the app is alive is delivered there and announced; the launch
    // Intent of a cold tap is delivered by `consumePendingRoute`.
    Events("onSystemSearchOpen")
    OnNewIntent { intent -> deliverPickedResult(intent) }

    AsyncFunction("applyUpdate") { add: List<SystemSearchRecord>, removeIds: List<String> ->
      backend.put(add.map(::toIndexedDocument))
      backend.remove(removeIds)
      Unit
    }

    AsyncFunction("indexedFingerprints") { ->
      backend.stored().associate { it.id to it.fingerprint }
    }

    AsyncFunction("clear") {
      backend.clear()
      Unit
    }

    // An `AsyncFunction` on purpose: resolving the identifier reads the index,
    // and that read must not run on the JavaScript thread that consumes the
    // slot. The module queue performs it instead (see `consumePendingRoute`).
    AsyncFunction("consumePendingRoute") { -> consumePendingRoute() }

    OnDestroy {
      // Each backend owns an AppSearch session, and the platform one owns its
      // executor thread as well, so a module instance must not outlive them: a
      // reload would otherwise leak one thread and one session per instance.
      // A module that never opened the index has nothing to close.
      openedBackend?.close()
      openedBackend = null
    }
  }

  /**
   * The route of the last search result the user opened, read and cleared in
   * one step, or null when there is none.
   *
   * Resolving the identifier reads the index, so it runs here — on the module
   * queue, because this is an `AsyncFunction` — rather than on the main thread
   * that delivers `OnNewIntent` or the JavaScript thread that consumes the
   * slot.
   *
   * A tap that launched this process has no event to announce — JavaScript is
   * still booting — so the launch Intent is read here, on the first consume and
   * only once.
   */
  private fun consumePendingRoute(): String? {
    val identifier = readAndClearPendingRoute() ?: takeLaunchIdentifier() ?: return null
    return resolveRoute(identifier)
  }

  /** The identifier of the launch Intent, taken once, or null when it is not ours. */
  private fun takeLaunchIdentifier(): String? {
    if (launchIntentRead) {
      return null
    }
    // Read it through the activity, and only mark it read once one exists: on a
    // cold start `currentActivity` can still be null when JavaScript makes its
    // first consume, and giving up then would forfeit the launch tap for the
    // rest of the process's life.
    val intent = appContext.currentActivity?.intent ?: return null
    launchIntentRead = true
    return pickedIdentifier(intent)
  }

  /**
   * Records one Intent the system raised for a picked result: the entry's
   * identifier goes into the single-shot slot and only then is the open event
   * announced, so the slot — not the event — carries the identifier. The
   * identifier is stored as the platform handed it back and resolved when the
   * slot is consumed, so this runs no index read on the main thread that
   * delivered the Intent. An Intent whose identifier the index does not hold —
   * the launcher Intent, a share, an ordinary deep link — resolves to nothing
   * when the slot is consumed and never navigates as a search tap.
   */
  private fun deliverPickedResult(intent: Intent?) {
    val identifier = pickedIdentifier(intent) ?: return
    if (!writePendingRoute(identifier)) {
      return
    }
    sendEvent("onSystemSearchOpen")
  }

  /**
   * The identifier this Intent carries for one of our entries: the entry's
   * `kiloapp://` link, or the qualified id of one of the documents the index
   * stores. Null for an Intent that carries neither.
   *
   * The link form is not proof by itself — `kiloapp://` is also the scheme the
   * app's ordinary deep links use — so it is only honoured once the index is
   * seen to hold it (see `resolveRoute`).
   */
  private fun pickedIdentifier(intent: Intent?): String? {
    val identifier = intent?.dataString?.takeIf { it.isNotBlank() } ?: return null
    if (identifier.startsWith(APP_SCHEME_PREFIX)) {
      return identifier
    }
    // The qualified-prefix form: `<package>$<database>/<namespace>#`.
    val prefix = qualifiedDocumentId("")
    return if (prefix != null && identifier.startsWith(prefix)) identifier else null
  }

  /**
   * The route the index holds for the picked entry, so the slot carries the
   * stored route whichever identifier form the platform handed back. Null when
   * the index does not hold the identifier.
   *
   * The index is the authority on which identifiers are ours: the app writes
   * one route per entry it indexes, so a `kiloapp://` link the index does not
   * carry is an ordinary deep link — the app's own scheme is what its deep
   * links use — and must not open as a search tap. The qualified-id form is
   * matched against the same stored entries.
   *
   * This is only ever called from an `AsyncFunction`, so the index read runs on
   * the module queue, never on the main thread that delivers the Intent or the
   * JavaScript thread that consumes the slot.
   */
  private fun resolveRoute(identifier: String): String? {
    val stored = try {
      backend.stored()
    } catch (error: Exception) {
      // Fail closed: the index is the only authority on which identifiers are
      // ours, and `kiloapp://` is also the scheme the app's ordinary deep links
      // use. Without the read there is no evidence this Intent came from our
      // index, so the identifier is refused rather than opened as a search tap.
      // The JavaScript allowlist only checks a route shape; it cannot prove the
      // Intent originated here. Report the read failure so the dropped tap is
      // not silent.
      Log.w(TAG, "Could not read the system search index to resolve a picked result.", error)
      return null
    }
    if (identifier.startsWith(APP_SCHEME_PREFIX)) {
      return identifier.takeIf { link -> stored.any { it.route == link } }
    }
    val matched = stored.firstOrNull { it.id == identifier || it.route == identifier }
      ?: stored.firstOrNull { qualifiedDocumentId(it.id) == identifier }
    return matched?.route?.takeIf { it.isNotEmpty() } ?: matched?.id ?: identifier
  }

  /**
   * The qualified id of one stored document, or null without a context.
   *
   * The Jetpack helper is used rather than `android.app.appsearch.util
   * .DocumentIdUtil`: it ships with this module's own dependency, so the
   * qualified form resolves on every API level the module runs on, and it
   * builds the same `<package>$<database>/<namespace>#<id>` string the platform
   * store's helper does.
   */
  private fun qualifiedDocumentId(documentId: String): String? {
    val packageName = appContext.reactContext?.packageName ?: return null
    return DocumentIdUtil.createQualifiedId(packageName, DATABASE_NAME, NAMESPACE, documentId)
  }

  /**
   * Writes the single-shot slot; false when there is no context to write it in.
   * The slot carries the identifier exactly as the platform handed it back.
   *
   * Runs on the main thread that delivers `OnNewIntent`, which is why it shares
   * `pendingRouteLock` with the read-and-clear below.
   */
  private fun writePendingRoute(identifier: String): Boolean {
    val context = appContext.reactContext ?: return false
    synchronized(pendingRouteLock) {
      context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)
        .edit()
        .putString(PENDING_ROUTE_KEY, identifier)
        .apply()
    }
    return true
  }

  /**
   * The slot's identifier, read and cleared as one step on the module queue.
   *
   * The write above happens on the main thread and `SharedPreferences` has no
   * read-and-clear operation, so the get and the remove are made atomic under
   * `pendingRouteLock`: otherwise a tap written between them is removed without
   * ever being resolved, and that tap never navigates.
   */
  private fun readAndClearPendingRoute(): String? {
    val context = appContext.reactContext ?: return null
    val preferences = context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)
    return synchronized(pendingRouteLock) {
      val identifier = preferences.getString(PENDING_ROUTE_KEY, null) ?: return@synchronized null
      preferences.edit().remove(PENDING_ROUTE_KEY).apply()
      identifier
    }
  }
}

private fun toIndexedDocument(record: SystemSearchRecord) = IndexedDocument(
  id = record.id,
  title = record.title,
  description = record.description,
  keywords = record.keywords,
  fingerprint = record.fingerprint,
  // The record's own link; the record id stays the fallback for a bundle that
  // predates `SystemSearchDocument.route`.
  route = record.route.ifEmpty { record.id }
)

private fun createSearchBackend(context: Context): SearchBackend =
  if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
    // API 31+ owns an AppSearch store; nothing below it may be reached.
    PlatformSearchBackend(context)
  } else {
    // Below 31 the same AppSearchSession contract is served locally.
    JetpackSearchBackend(context)
  }

/**
 * Opens the platform AppSearch session, releasing what it opened when either
 * step fails.
 *
 * `openBackend` keeps a backend only once its constructor returns, so a throw
 * here — an unavailable service, a failed `createSearchSession` or `setSchema`
 * — would otherwise leave the executor's non-daemon thread running, and any
 * session already created with it, once per retry of the lazy open.
 */
@RequiresApi(Build.VERSION_CODES.S)
private fun openPlatformSession(context: Context, executor: ExecutorService): AppSearchSession {
  var opened: AppSearchSession? = null
  try {
    val manager = context.getSystemService(AppSearchManager::class.java)
      ?: throw CodedException("The system search index is unavailable on this device.")
    val searchContext = AppSearchManager.SearchContext.Builder(DATABASE_NAME).build()
    val created = awaitPlatformResult { callback ->
      manager.createSearchSession(searchContext, executor, callback)
    }
    opened = created
    awaitPlatformResult { callback ->
      created.setSchema(platformSchemaRequest(context), executor, executor, callback)
    }
    return created
  } catch (error: Throwable) {
    opened?.close()
    executor.shutdown()
    throw error
  }
}

/** The platform `android.app.appsearch` store, available from API 31. */
@RequiresApi(Build.VERSION_CODES.S)
private class PlatformSearchBackend(context: Context) : SearchBackend {
  private val executor = Executors.newSingleThreadExecutor()
  private val session: AppSearchSession = openPlatformSession(context, executor)

  override fun put(documents: List<IndexedDocument>) {
    if (documents.isEmpty()) return
    val request = PutDocumentsRequest.Builder()
      .addGenericDocuments(documents.map(::platformDocument))
      .build()
    awaitPlatformBatch { callback -> session.put(request, executor, callback) }
  }

  override fun remove(ids: List<String>) {
    if (ids.isEmpty()) return
    val request = RemoveByDocumentIdRequest.Builder(NAMESPACE).addIds(ids).build()
    awaitPlatformBatch { callback -> session.remove(request, executor, callback) }
  }

  override fun clear() {
    // The remove-by-query callback carries an `AppSearchResult<Void>`, whose
    // `resultValue` is null even on success, so this awaits completion only.
    awaitPlatformCompletion { callback -> session.remove("", platformNamespaceSpec(), executor, callback) }
  }

  override fun stored(): List<StoredDocument> {
    val stored = mutableListOf<StoredDocument>()
    session.search("", platformNamespaceSpec()).use { results ->
      var page = awaitPlatformResult<List<SearchResult>> { callback ->
        results.getNextPage(executor, callback)
      }
      while (page.isNotEmpty()) {
        for (result in page) {
          storedPlatformDocument(result.genericDocument)?.let { stored += it }
        }
        if (page.size < PAGE_SIZE) break
        page = awaitPlatformResult { callback -> results.getNextPage(executor, callback) }
      }
    }
    return stored
  }

  override fun close() {
    session.close()
    executor.shutdown()
  }
}

/**
 * Opens the Jetpack local store's session, releasing it when the schema write
 * fails.
 *
 * As on the platform store, `openBackend` keeps a backend only once its
 * constructor returns, so a failed `setSchema` would otherwise leave this
 * session open once per retry of the lazy open.
 */
private fun openJetpackSession(context: Context): JetpackSession {
  val session = LocalStorage
    .createSearchSessionAsync(LocalStorage.SearchContext.Builder(context, DATABASE_NAME).build())
    .awaitFuture()
  try {
    session.setSchemaAsync(jetpackSchemaRequest()).awaitFuture()
  } catch (error: Throwable) {
    session.close()
    throw error
  }
  return session
}

/** The Jetpack local store that backs the same session contract below API 31. */
private class JetpackSearchBackend(context: Context) : SearchBackend {
  private val session: JetpackSession = openJetpackSession(context)

  override fun put(documents: List<IndexedDocument>) {
    if (documents.isEmpty()) return
    val request = JetpackPutRequest.Builder()
      .addGenericDocuments(documents.map(::jetpackDocument))
      .build()
    checkBatch(session.putAsync(request).awaitFuture())
  }

  override fun remove(ids: List<String>) {
    if (ids.isEmpty()) return
    val request = JetpackRemoveRequest.Builder(NAMESPACE).addIds(ids).build()
    checkBatch(session.removeAsync(request).awaitFuture())
  }

  override fun clear() {
    // Unlike `put` and `remove` by id, a remove-by-query answers with the wipe's
    // own completion rather than a batch result: `removeAsync(queryExpression,
    // searchSpec)` resolves to `Void` and fails the future when the store cannot
    // finish the wipe, so awaiting it — not `checkBatch` — is what makes a
    // failed clear throw instead of resolving as success. The platform store's
    // remove-by-query answers a completion too.
    session.removeAsync("", jetpackNamespaceSpec()).awaitFuture()
  }

  override fun stored(): List<StoredDocument> {
    val stored = mutableListOf<StoredDocument>()
    session.search("", jetpackNamespaceSpec()).use { results ->
      var page = results.getNextPageAsync().awaitFuture()
      while (page.isNotEmpty()) {
        for (result in page) {
          storedJetpackDocument(result.genericDocument)?.let { stored += it }
        }
        if (page.size < PAGE_SIZE) break
        page = results.getNextPageAsync().awaitFuture()
      }
    }
    return stored
  }

  override fun close() {
    session.close()
  }
}

private fun checkBatch(result: JetpackBatchResult<String, Void>) {
  if (result.isSuccess) return
  val failure = result.failures.values.firstOrNull()
  throw CodedException(failure?.errorMessage ?: "The system search index rejected a document.")
}

private fun platformNamespaceSpec(): SearchSpec = SearchSpec.Builder()
  .addFilterNamespaces(NAMESPACE)
  .setResultCountPerPage(PAGE_SIZE)
  .build()

private fun jetpackNamespaceSpec(): JetpackSearchSpec = JetpackSearchSpec.Builder()
  .addFilterNamespaces(NAMESPACE)
  .setResultCountPerPage(PAGE_SIZE)
  .build()

// The type is displayed on the system search surfaces on purpose: this index
// exists to be read there, so the request states it rather than relying on the
// API's default. Documented at
// `SetSchemaRequest.Builder.setSchemaTypeDisplayedBySystem`.
private fun platformSchemaRequest(context: Context?): SetSchemaRequest {
  val builder = SetSchemaRequest.Builder()
    .addSchemas(platformSchema())
    .setSchemaTypeDisplayedBySystem(SCHEMA_TYPE, true)
    .setForceOverride(true)
  // From API 35 the schema is additionally made publicly visible to the
  // phone's own search surface. A surface without
  // `READ_GLOBAL_APP_SEARCH_DATA` — the launcher's Google search holds none on
  // the images seen here — can only read a foreign database the owner has
  // named this way, and the platform honours the name only against the
  // installed app (`VisibilityCheckerImpl` re-checks the named certificate
  // against the installed package at query time). Google ships that app signed
  // differently per image family — GMS release keys, OEM keys, the emulator's
  // platform test key — so no single hardcoded certificate can name it, and
  // the surface's own installed certificate is read instead. On a device
  // without the surface the grant is simply not made.
  if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.VANILLA_ICE_CREAM) {
    globalSearchSurfaceCertificate(context)?.let { certificate ->
      builder.setPubliclyVisibleSchema(
        SCHEMA_TYPE,
        PackageIdentifier(GLOBAL_SEARCH_PACKAGE, certificate)
      )
    }
  }
  return builder.build()
}

/**
 * The signing certificate of the phone's own search surface, as the SHA-256
 * digest the visibility grant names, or null when the surface is not installed
 * or not visible to this app.
 */
private fun globalSearchSurfaceCertificate(context: Context?): ByteArray? {
  if (context == null) return null
  return try {
    val info = context.packageManager.getPackageInfo(
      GLOBAL_SEARCH_PACKAGE,
      PackageManager.GET_SIGNING_CERTIFICATES
    )
    val signer = info.signingInfo?.apkContentsSigners?.firstOrNull() ?: return null
    MessageDigest.getInstance("SHA-256").digest(signer.toByteArray())
  } catch (error: Exception) {
    null
  }
}

private fun jetpackSchemaRequest(): JetpackSetSchemaRequest = JetpackSetSchemaRequest.Builder()
  .addSchemas(jetpackSchema())
  .setSchemaTypeDisplayedBySystem(SCHEMA_TYPE, true)
  .setForceOverride(true)
  .build()

private fun platformSchema(): AppSearchSchema = AppSearchSchema.Builder(SCHEMA_TYPE)
  .addProperty(
    platformStringProperty(
      PROPERTY_ID,
      AppSearchSchema.PropertyConfig.CARDINALITY_OPTIONAL,
      AppSearchSchema.StringPropertyConfig.INDEXING_TYPE_NONE
    )
  )
  .addProperty(
    platformStringProperty(
      PROPERTY_TITLE,
      AppSearchSchema.PropertyConfig.CARDINALITY_OPTIONAL,
      AppSearchSchema.StringPropertyConfig.INDEXING_TYPE_PREFIXES
    )
  )
  .addProperty(
    platformStringProperty(
      PROPERTY_DESCRIPTION,
      AppSearchSchema.PropertyConfig.CARDINALITY_OPTIONAL,
      AppSearchSchema.StringPropertyConfig.INDEXING_TYPE_PREFIXES
    )
  )
  .addProperty(
    platformStringProperty(
      PROPERTY_KEYWORDS,
      AppSearchSchema.PropertyConfig.CARDINALITY_REPEATED,
      AppSearchSchema.StringPropertyConfig.INDEXING_TYPE_PREFIXES
    )
  )
  .addProperty(
    platformStringProperty(
      PROPERTY_FINGERPRINT,
      AppSearchSchema.PropertyConfig.CARDINALITY_OPTIONAL,
      AppSearchSchema.StringPropertyConfig.INDEXING_TYPE_NONE
    )
  )
  .addProperty(
    platformStringProperty(
      PROPERTY_ROUTE,
      AppSearchSchema.PropertyConfig.CARDINALITY_OPTIONAL,
      AppSearchSchema.StringPropertyConfig.INDEXING_TYPE_NONE
    )
  )
  .build()

private fun jetpackSchema(): JetpackSchema = JetpackSchema.Builder(SCHEMA_TYPE)
  .addProperty(
    jetpackStringProperty(
      PROPERTY_ID,
      JetpackSchema.PropertyConfig.CARDINALITY_OPTIONAL,
      JetpackSchema.StringPropertyConfig.INDEXING_TYPE_NONE
    )
  )
  .addProperty(
    jetpackStringProperty(
      PROPERTY_TITLE,
      JetpackSchema.PropertyConfig.CARDINALITY_OPTIONAL,
      JetpackSchema.StringPropertyConfig.INDEXING_TYPE_PREFIXES
    )
  )
  .addProperty(
    jetpackStringProperty(
      PROPERTY_DESCRIPTION,
      JetpackSchema.PropertyConfig.CARDINALITY_OPTIONAL,
      JetpackSchema.StringPropertyConfig.INDEXING_TYPE_PREFIXES
    )
  )
  .addProperty(
    jetpackStringProperty(
      PROPERTY_KEYWORDS,
      JetpackSchema.PropertyConfig.CARDINALITY_REPEATED,
      JetpackSchema.StringPropertyConfig.INDEXING_TYPE_PREFIXES
    )
  )
  .addProperty(
    jetpackStringProperty(
      PROPERTY_FINGERPRINT,
      JetpackSchema.PropertyConfig.CARDINALITY_OPTIONAL,
      JetpackSchema.StringPropertyConfig.INDEXING_TYPE_NONE
    )
  )
  .addProperty(
    jetpackStringProperty(
      PROPERTY_ROUTE,
      JetpackSchema.PropertyConfig.CARDINALITY_OPTIONAL,
      JetpackSchema.StringPropertyConfig.INDEXING_TYPE_NONE
    )
  )
  .build()

// A searchable property must name its tokenizer: the platform builder defaults
// it to TOKENIZER_TYPE_NONE and `build()` rejects any indexing type other than
// INDEXING_TYPE_NONE with it, which fails `setSchema` for the whole database.
// (`IllegalStateException: Cannot set TOKENIZER_TYPE_NONE with an indexing type
// other than INDEXING_TYPE_NONE.`, seen on the API 35 emulator.)
private fun platformStringProperty(name: String, cardinality: Int, indexingType: Int): AppSearchSchema.PropertyConfig {
  val builder = AppSearchSchema.StringPropertyConfig.Builder(name)
    .setCardinality(cardinality)
    .setIndexingType(indexingType)
  if (indexingType != AppSearchSchema.StringPropertyConfig.INDEXING_TYPE_NONE) {
    builder.setTokenizerType(AppSearchSchema.StringPropertyConfig.TOKENIZER_TYPE_PLAIN)
  }
  return builder.build()
}

private fun jetpackStringProperty(name: String, cardinality: Int, indexingType: Int): JetpackSchema.PropertyConfig {
  val builder = JetpackSchema.StringPropertyConfig.Builder(name)
    .setCardinality(cardinality)
    .setIndexingType(indexingType)
  if (indexingType != JetpackSchema.StringPropertyConfig.INDEXING_TYPE_NONE) {
    builder.setTokenizerType(JetpackSchema.StringPropertyConfig.TOKENIZER_TYPE_PLAIN)
  }
  return builder.build()
}

/** The stored shape of one platform document, or null without a fingerprint. */
private fun storedPlatformDocument(document: GenericDocument): StoredDocument? {
  val fingerprint = document.getPropertyString(PROPERTY_FINGERPRINT) ?: return null
  return StoredDocument(
    id = document.getPropertyString(PROPERTY_ID) ?: document.id,
    fingerprint = fingerprint,
    route = document.getPropertyString(PROPERTY_ROUTE) ?: ""
  )
}

/** The stored shape of one Jetpack document, or null without a fingerprint. */
private fun storedJetpackDocument(document: JetpackDocument): StoredDocument? {
  val fingerprint = document.getPropertyString(PROPERTY_FINGERPRINT) ?: return null
  return StoredDocument(
    id = document.getPropertyString(PROPERTY_ID) ?: document.id,
    fingerprint = fingerprint,
    route = document.getPropertyString(PROPERTY_ROUTE) ?: ""
  )
}

private fun platformDocument(document: IndexedDocument): GenericDocument {
  val builder = GenericDocument.Builder<GenericDocument.Builder<*>>(NAMESPACE, document.id, SCHEMA_TYPE)
  builder.setPropertyString(PROPERTY_ID, document.id)
  builder.setPropertyString(PROPERTY_TITLE, document.title)
  builder.setPropertyString(PROPERTY_DESCRIPTION, document.description)
  if (document.keywords.isNotEmpty()) {
    builder.setPropertyString(PROPERTY_KEYWORDS, *document.keywords.toTypedArray())
  }
  builder.setPropertyString(PROPERTY_FINGERPRINT, document.fingerprint)
  builder.setPropertyString(PROPERTY_ROUTE, document.route)
  return builder.build()
}

private fun jetpackDocument(document: IndexedDocument): JetpackDocument {
  val builder =
    JetpackDocument.Builder<JetpackDocument.Builder<*>>(NAMESPACE, document.id, SCHEMA_TYPE)
  builder.setPropertyString(PROPERTY_ID, document.id)
  builder.setPropertyString(PROPERTY_TITLE, document.title)
  builder.setPropertyString(PROPERTY_DESCRIPTION, document.description)
  if (document.keywords.isNotEmpty()) {
    builder.setPropertyString(PROPERTY_KEYWORDS, *document.keywords.toTypedArray())
  }
  builder.setPropertyString(PROPERTY_FINGERPRINT, document.fingerprint)
  builder.setPropertyString(PROPERTY_ROUTE, document.route)
  return builder.build()
}

private fun platformFailure(code: Int, message: String?): Throwable =
  CodedException(message ?: "The system search index failed with code $code.")

private fun <T> awaitPlatformResult(start: (Consumer<AppSearchResult<T>>) -> Unit): T {
  val latch = CountDownLatch(1)
  var value: T? = null
  var failure: Throwable? = null
  start { result ->
    if (result.isSuccess) {
      value = result.resultValue
    } else {
      failure = platformFailure(result.resultCode, result.errorMessage)
    }
    latch.countDown()
  }
  if (!latch.await(TIMEOUT_SECONDS, TimeUnit.SECONDS)) throw CodedException(TIMEOUT_MESSAGE)
  failure?.let { throw it }
  return value ?: throw CodedException("The system search index returned no result.")
}

// A remove-by-query callback carries an `AppSearchResult<Void>`: the result has
// no value even when it succeeds, so only success and failure are observed.
private fun awaitPlatformCompletion(start: (Consumer<AppSearchResult<Void>>) -> Unit) {
  val latch = CountDownLatch(1)
  var failure: Throwable? = null
  start { result ->
    if (!result.isSuccess) {
      failure = platformFailure(result.resultCode, result.errorMessage)
    }
    latch.countDown()
  }
  if (!latch.await(TIMEOUT_SECONDS, TimeUnit.SECONDS)) throw CodedException(TIMEOUT_MESSAGE)
  failure?.let { throw it }
}

private fun awaitPlatformBatch(start: (BatchResultCallback<String, Void>) -> Unit) {
  val latch = CountDownLatch(1)
  var failure: Throwable? = null
  start(object : BatchResultCallback<String, Void> {
    override fun onResult(result: AppSearchBatchResult<String, Void>) {
      if (!result.isSuccess) {
        val rejected = result.failures.values.firstOrNull()
        failure = platformFailure(
          rejected?.resultCode ?: AppSearchResult.RESULT_UNKNOWN_ERROR,
          rejected?.errorMessage
        )
      }
      latch.countDown()
    }

    override fun onSystemError(error: Throwable?) {
      // AppSearch can report a system error without a throwable. A null is
      // still a failure: leaving `failure` unset would let the latch return and
      // the caller treat the batch as applied even though the index never
      // completed it. The Jetpack path's `awaitFuture` throws here, so this
      // keeps the two stores answering the same way.
      failure = error ?: platformFailure(AppSearchResult.RESULT_UNKNOWN_ERROR, null)
      latch.countDown()
    }
  })
  if (!latch.await(TIMEOUT_SECONDS, TimeUnit.SECONDS)) throw CodedException(TIMEOUT_MESSAGE)
  failure?.let { throw it }
}

private fun <T> ListenableFuture<T>.awaitFuture(): T = try {
  get(TIMEOUT_SECONDS, TimeUnit.SECONDS)
} catch (error: ExecutionException) {
  throw error.cause ?: error
}
