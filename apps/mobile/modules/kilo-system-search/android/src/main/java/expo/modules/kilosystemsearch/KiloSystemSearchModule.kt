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
private const val PAGE_SIZE = 100
private const val TIMEOUT_SECONDS = 30L
private const val TIMEOUT_MESSAGE = "The system search index did not respond."

/**
 * One indexed entity, as JavaScript hands it across.
 *
 * `route` is optional: `SystemSearchDocument` in `src/lib/native-system-search.ts`
 * does not carry it, so the indexed route falls back to the record id, which is
 * the same identifier iOS returns from `consumePendingRoute`.
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

/**
 * The subset of an AppSearch session this module uses, so the platform store
 * (API 31+) and the Jetpack local store (below 31) can both back it.
 */
private interface SearchBackend {
  fun put(documents: List<IndexedDocument>)
  fun remove(ids: List<String>)
  fun clear()
  fun fingerprints(): Map<String, String>
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

  override fun definition() = ModuleDefinition {
    Name("KiloSystemSearch")
    // Android delivers a tapped app-search result through the `kiloapp://` deep
    // link, which `src/app/+native-intent.tsx` and `src/lib/deep-link-handler.ts`
    // resolve for `/agent-chat/<id>`, `/pr-review/...` and `/security-agent/...`.
    // Nothing in the app therefore emits this event on Android; it stays declared
    // so the JS bridge has one contract on both platforms.
    Events("onSystemSearchOpen")

    AsyncFunction("applyUpdate") { add: List<SystemSearchRecord>, removeIds: List<String> ->
      backend.put(add.map(::toIndexedDocument))
      backend.remove(removeIds)
      Unit
    }

    AsyncFunction("indexedFingerprints") { -> backend.fingerprints() }

    AsyncFunction("clear") {
      backend.clear()
      Unit
    }

    // Nothing writes the slot on Android because the deep link already carries the
    // target screen. The member exists so both platforms answer the same contract.
    Function("consumePendingRoute") { -> consumePendingRoute() }
  }

  private fun consumePendingRoute(): String? {
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
  // `kiloapp://` + this path is the app's own deep link for the entry, and the
  // record id is the path iOS hands back through `consumePendingRoute`.
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

  override fun fingerprints(): Map<String, String> {
    val fingerprints = mutableMapOf<String, String>()
    session.search("", platformNamespaceSpec()).use { results ->
      var page = awaitPlatformResult<List<SearchResult>> { callback ->
        results.getNextPage(executor, callback)
      }
      while (page.isNotEmpty()) {
        for (result in page) {
          val document = result.genericDocument
          document.getPropertyString(PROPERTY_FINGERPRINT)?.let { fingerprints[document.id] = it }
        }
        if (page.size < PAGE_SIZE) break
        page = awaitPlatformResult { callback -> results.getNextPage(executor, callback) }
      }
    }
    return fingerprints
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

  override fun fingerprints(): Map<String, String> {
    val fingerprints = mutableMapOf<String, String>()
    session.search("", jetpackNamespaceSpec()).use { results ->
      var page = results.getNextPageAsync().awaitFuture()
      while (page.isNotEmpty()) {
        for (result in page) {
          val document = result.genericDocument
          document.getPropertyString(PROPERTY_FINGERPRINT)?.let { fingerprints[document.id] = it }
        }
        if (page.size < PAGE_SIZE) break
        page = results.getNextPageAsync().awaitFuture()
      }
    }
    return fingerprints
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

private fun platformSchemaRequest(): SetSchemaRequest = SetSchemaRequest.Builder()
  .addSchemas(platformSchema())
  .setForceOverride(true)
  .build()

private fun jetpackSchemaRequest(): JetpackSetSchemaRequest = JetpackSetSchemaRequest.Builder()
  .addSchemas(jetpackSchema())
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

private fun platformStringProperty(name: String, cardinality: Int, indexingType: Int): AppSearchSchema.PropertyConfig =
  AppSearchSchema.StringPropertyConfig.Builder(name)
    .setCardinality(cardinality)
    .setIndexingType(indexingType)
    .build()

private fun jetpackStringProperty(name: String, cardinality: Int, indexingType: Int): JetpackSchema.PropertyConfig =
  JetpackSchema.StringPropertyConfig.Builder(name)
    .setCardinality(cardinality)
    .setIndexingType(indexingType)
    .build()

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
