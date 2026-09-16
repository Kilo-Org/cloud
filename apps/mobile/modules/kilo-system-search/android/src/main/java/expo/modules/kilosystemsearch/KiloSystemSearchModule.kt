package expo.modules.kilosystemsearch

import android.app.appsearch.AppSearchBatchResult
import android.app.appsearch.AppSearchManager
import android.app.appsearch.AppSearchResult
import android.app.appsearch.AppSearchSchema
import android.app.appsearch.AppSearchSession
import android.app.appsearch.BatchResultCallback
import android.app.appsearch.GenericDocument
import android.app.appsearch.PutDocumentsRequest
import android.app.appsearch.RemoveByDocumentIdRequest
import android.app.appsearch.SearchResult
import android.app.appsearch.SearchSpec
import android.app.appsearch.SetSchemaRequest
import android.content.Context
import android.content.Intent
import android.os.Build
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
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.function.Consumer

private const val NAMESPACE = "kilo"
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
  fun close()
}

class KiloSystemSearchModule : Module() {
  // Created on the first call so the database only opens when the app indexes
  // something. `appContext.reactContext` is the long-lived application context.
  private val backend: SearchBackend by lazy {
    val context = appContext.reactContext?.applicationContext
      ?: throw CodedException("A React context is required to use the system search index.")
    createSearchBackend(context)
  }

  // The launching Intent is the tap on a cold start, and it is delivered once:
  // every later delivery comes from `OnNewIntent` instead.
  private var launchIntentRead = false

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

    Function("consumePendingRoute") { -> consumePendingRoute() }
  }

  /**
   * The identifier of the last search result the user opened, read and cleared
   * in one step, or null when there is none.
   *
   * A tap that launched this process has no event to announce — JavaScript is
   * still booting — so the launch Intent is read here, on the first consume and
   * only once, and written to the same slot before it is read back.
   */
  private fun consumePendingRoute(): String? {
    readAndClearPendingRoute()?.let { return it }
    if (!launchIntentRead) {
      launchIntentRead = true
      deliverPickedResult(appContext.currentActivity?.intent)
    }
    return readAndClearPendingRoute()
  }

  /**
   * Delivers one Intent the system raised for a picked result: the entry's
   * stored route goes into the single-shot slot and only then is the open event
   * announced, so the slot — not the event — carries the route. Any other
   * Intent (the launcher Intent, an ordinary deep link, a share) is ignored.
   */
  private fun deliverPickedResult(intent: Intent?) {
    val identifier = pickedIdentifier(intent) ?: return
    if (!writePendingRoute(resolveRoute(identifier))) {
      return
    }
    sendEvent("onSystemSearchOpen")
  }

  /**
   * The identifier this Intent carries for one of our entries: the entry's
   * `kiloapp://` link, or the qualified id of one of the documents the index
   * stores. Null for every other Intent, which is why only the app's own search
   * entries are read out of one.
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
   * stored route whichever identifier form the platform handed back. Falls back
   * to the identifier itself: a stale or unreadable index must never lose the
   * tap, and the JS side refuses anything it did not issue.
   */
  private fun resolveRoute(identifier: String): String {
    val stored = try {
      backend.stored()
    } catch (error: Exception) {
      emptyList()
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

  /** Writes the slot; false when there is no context to write it in. */
  private fun writePendingRoute(route: String): Boolean {
    val context = appContext.reactContext ?: return false
    context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)
      .edit()
      .putString(PENDING_ROUTE_KEY, route)
      .apply()
    return true
  }

  private fun readAndClearPendingRoute(): String? {
    val context = appContext.reactContext ?: return null
    val preferences = context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)
    val route = preferences.getString(PENDING_ROUTE_KEY, null) ?: return null
    preferences.edit().remove(PENDING_ROUTE_KEY).apply()
    return route
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

/** The platform `android.app.appsearch` store, available from API 31. */
@RequiresApi(Build.VERSION_CODES.S)
private class PlatformSearchBackend(context: Context) : SearchBackend {
  private val executor = Executors.newSingleThreadExecutor()
  private val session: AppSearchSession

  init {
    val manager = context.getSystemService(AppSearchManager::class.java)
      ?: throw CodedException("The system search index is unavailable on this device.")
    val searchContext = AppSearchManager.SearchContext.Builder(DATABASE_NAME).build()
    session = awaitPlatformResult { callback ->
      manager.createSearchSession(searchContext, executor, callback)
    }
    awaitPlatformResult { callback ->
      session.setSchema(platformSchemaRequest(), executor, executor, callback)
    }
  }

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

/** The Jetpack local store that backs the same session contract below API 31. */
private class JetpackSearchBackend(context: Context) : SearchBackend {
  private val session: JetpackSession = LocalStorage
    .createSearchSessionAsync(LocalStorage.SearchContext.Builder(context, DATABASE_NAME).build())
    .awaitFuture()

  init {
    session.setSchemaAsync(jetpackSchemaRequest()).awaitFuture()
  }

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
private fun platformSchemaRequest(): SetSchemaRequest = SetSchemaRequest.Builder()
  .addSchemas(platformSchema())
  .setSchemaTypeDisplayedBySystem(SCHEMA_TYPE, true)
  .setForceOverride(true)
  .build()

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
      failure = error
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
