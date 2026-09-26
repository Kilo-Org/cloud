package com.kilocode.artifactsprovider

import android.content.Context
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.CancellationSignal
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract
import android.provider.DocumentsContract.Document
import android.provider.DocumentsContract.Root
import android.provider.DocumentsProvider
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.io.FileNotFoundException

/**
 * Read-only [DocumentsProvider] over the artifact mirror, so the phone's file
 * browser shows a "Kilo" location with one folder per session and the files an
 * agent produced.
 *
 * The mirror is written by the JS side (`apps/mobile/src/lib/artifacts/`):
 * `artifact-mirror.ts` owns the layout — `<filesDir>/artifacts/manifest.json`
 * plus `sessions/<sessionId>/<fileId>` — and `artifact-mirror-manifest.ts` owns
 * the manifest keys parsed here (`version`, `sessions[].id|title`,
 * `sessions[].files[].id|name|mime|size`). Move the three together.
 *
 * Read-only by contract: every write-back entry point throws, and the rows carry
 * no `FLAG_SUPPORTS_WRITE` or `FLAG_SUPPORTS_DELETE`.
 *
 * Document ids:
 * - [ROOT_ID] is the one root, titled "Kilo".
 * - a session is addressed by its manifest `id`.
 * - a file is addressed by `<session id>/<file id>`.
 */
class ArtifactsDocumentsProvider : DocumentsProvider() {
  override fun onCreate(): Boolean = true

  override fun queryRoots(projection: Array<out String>?): Cursor {
    val cursor = MatrixCursor(resolveProjection(projection, DEFAULT_ROOT_PROJECTION))
    val row = cursor.newRow()
    row.add(Root.COLUMN_ROOT_ID, ROOT_ID)
    row.add(Root.COLUMN_DOCUMENT_ID, ROOT_ID)
    row.add(Root.COLUMN_TITLE, ROOT_TITLE)
    // Local-only and read-only: no FLAG_SUPPORTS_CREATE, no FLAG_SUPPORTS_DELETE.
    row.add(Root.COLUMN_FLAGS, Root.FLAG_LOCAL_ONLY)
    row.add(Root.COLUMN_MIME_TYPES, "*/*")
    return cursor
  }

  override fun queryChildDocuments(
    parentDocumentId: String,
    projection: Array<out String>?,
    sortOrder: String?,
  ): Cursor {
    val cursor = MatrixCursor(resolveProjection(projection, DEFAULT_DOCUMENT_PROJECTION))
    val sessions = readSessions()
    if (parentDocumentId == ROOT_ID) {
      for (session in sessions) {
        sessionRow(session).addTo(cursor)
      }
      return cursor
    }
    // A session with no files, a session the snapshot dropped and an unknown
    // parent all return an empty cursor: the file browser shows an empty folder
    // instead of an error.
    val session = sessions.firstOrNull { it.id == parentDocumentId } ?: return cursor
    for (file in session.files) {
      fileRow(session.id, file).addTo(cursor)
    }
    return cursor
  }

  override fun queryDocument(documentId: String, projection: Array<out String>?): Cursor {
    val cursor = MatrixCursor(resolveProjection(projection, DEFAULT_DOCUMENT_PROJECTION))
    if (documentId == ROOT_ID) {
      rootRow().addTo(cursor)
      return cursor
    }
    val sessions = readSessions()
    sessions.firstOrNull { it.id == documentId }?.let { session ->
      sessionRow(session).addTo(cursor)
      return cursor
    }
    val file = findFile(documentId, sessions)
      ?: throw FileNotFoundException("No artifact document $documentId")
    fileRow(file.session.id, file.entry).addTo(cursor)
    return cursor
  }

  override fun getDocumentType(documentId: String): String {
    if (documentId == ROOT_ID) {
      return Document.MIME_TYPE_DIR
    }
    val sessions = readSessions()
    if (sessions.any { it.id == documentId }) {
      return Document.MIME_TYPE_DIR
    }
    return findFile(documentId, sessions)?.entry?.mime
      ?: throw FileNotFoundException("No artifact document $documentId")
  }

  override fun openDocument(
    documentId: String,
    mode: String,
    signal: CancellationSignal?,
  ): ParcelFileDescriptor {
    if (mode != READ_MODE) {
      throw FileNotFoundException("Read-only artifact provider cannot open $documentId for $mode")
    }
    val file = resolveFile(documentId)
      ?: throw FileNotFoundException("No artifact document $documentId")
    if (!file.isFile) {
      throw FileNotFoundException("No artifact file on disk for $documentId")
    }
    return ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
  }

  override fun createDocument(parentDocumentId: String, mimeType: String, displayName: String): String {
    throw FileNotFoundException(READ_ONLY_MESSAGE)
  }

  override fun deleteDocument(documentId: String) {
    throw FileNotFoundException(READ_ONLY_MESSAGE)
  }

  override fun renameDocument(documentId: String, displayName: String): String {
    throw FileNotFoundException(READ_ONLY_MESSAGE)
  }

  override fun moveDocument(
    sourceDocumentId: String,
    sourceParentDocumentId: String,
    targetParentDocumentId: String,
  ): String {
    throw FileNotFoundException(READ_ONLY_MESSAGE)
  }

  /**
   * The bytes a `session/file` document id addresses: `<mirror>/sessions/<session
   * id>/<file id>`. The display name never reaches the filesystem, so a name that
   * carries a path cannot escape the session folder.
   */
  private fun resolveFile(documentId: String): File? {
    val file = findFile(documentId, readSessions()) ?: return null
    val sessionDirectory = File(File(artifactsDirectory, SESSIONS_DIRECTORY_NAME), file.session.id)
    return File(sessionDirectory, file.entry.id)
  }

  private fun findFile(documentId: String, sessions: List<ManifestSession>): ArtifactFile? {
    val sessionId = documentId.substringBefore('/', missingDelimiterValue = "")
    val fileId = documentId.substringAfter('/', missingDelimiterValue = "")
    if (sessionId.isEmpty() || fileId.isEmpty()) {
      return null
    }
    val session = sessions.firstOrNull { it.id == sessionId } ?: return null
    val entry = session.files.firstOrNull { it.id == fileId } ?: return null
    return ArtifactFile(session, entry)
  }

  /** Parsed manifest, keyed by [cachedManifestStamp]. */
  private var cachedSessions: List<ManifestSession>? = null

  /** `lastModified()` plus `length()` of the file [cachedSessions] was parsed from. */
  private var cachedManifestStamp: ManifestStamp? = null

  /**
   * The parsed manifest, re-read and re-parsed only when the file's stamp
   * changed. The mirror rewrites `manifest.json` wholesale through a `.part`
   * file and a rename, so both `lastModified()` and `length()` change on every
   * rewrite. A missing or unreadable file is an empty location, never a stale
   * cache. `@Synchronized` because DocumentsProvider callbacks arrive on binder
   * threads.
   *
   * Serving the mirror in-process from `context.filesDir` is the capability
   * Android has and iOS does not: Android has no app group. iOS's counterpart,
   * `targets/ArtifactsFileProvider/ArtifactsFileProviderExtension.swift`,
   * memoizes the same index out of the shared app group on the same
   * modification-date-and-size stamp, so one browse costs one parse per platform
   * instead of one per row.
   */
  @Synchronized
  private fun readSessions(): List<ManifestSession> {
    val manifest = File(artifactsDirectory, MANIFEST_FILE_NAME)
    if (!manifest.isFile) {
      cachedSessions = null
      cachedManifestStamp = null
      return emptyList()
    }
    val stamp = ManifestStamp(manifest.lastModified(), manifest.length())
    val cached = cachedSessions
    if (cached != null && stamp == cachedManifestStamp) {
      return cached
    }
    return try {
      val sessions = parseManifest(manifest.readText())
      cachedSessions = sessions
      cachedManifestStamp = stamp
      sessions
    } catch (error: Exception) {
      // A malformed manifest is an empty location in the file browser, never a
      // crash inside DocumentsUI; the mirror only writes derived data.
      Log.w(TAG, "Ignoring unreadable artifact manifest", error)
      cachedSessions = null
      cachedManifestStamp = null
      emptyList()
    }
  }

  /** Parses the manifest `artifactMirrorManifestSchema` writes. An unknown version reads as absent. */
  private fun parseManifest(raw: String): List<ManifestSession> {
    val manifest = JSONObject(raw)
    val version = manifest.optInt(KEY_VERSION, 0)
    if (version != SUPPORTED_MANIFEST_VERSION) {
      Log.w(TAG, "Ignoring artifact manifest version $version, expected $SUPPORTED_MANIFEST_VERSION")
      return emptyList()
    }
    val rawSessions = manifest.optJSONArray(KEY_SESSIONS) ?: return emptyList()
    val sessions = ArrayList<ManifestSession>(rawSessions.length())
    for (sessionIndex in 0 until rawSessions.length()) {
      val rawSession = rawSessions.optJSONObject(sessionIndex) ?: continue
      val sessionId = safeDocumentId(rawSession.optString(KEY_ID), allowSlashes = false) ?: continue
      val files = ArrayList<ManifestFile>()
      val rawFiles = rawSession.optJSONArray(KEY_FILES)
      if (rawFiles != null) {
        for (fileIndex in 0 until rawFiles.length()) {
          val rawFile = rawFiles.optJSONObject(fileIndex) ?: continue
          val fileId = safeDocumentId(rawFile.optString(KEY_ID), allowSlashes = true) ?: continue
          val name = rawFile.optString(KEY_NAME).takeIf { it.isNotEmpty() } ?: fileId
          val mime = rawFile.optString(KEY_MIME).takeIf { it.isNotEmpty() } ?: DEFAULT_MIME_TYPE
          val size = if (rawFile.isNull(KEY_SIZE)) null else rawFile.optLong(KEY_SIZE)
          files.add(ManifestFile(fileId, name, mime, size))
        }
      }
      val title = rawSession.optString(KEY_TITLE).takeIf { it.isNotEmpty() } ?: sessionId
      sessions.add(ManifestSession(sessionId, title, files))
    }
    return sessions
  }

  /**
   * A document id addresses a file below the mirror, so it can never be an
   * absolute path or climb out with `..`. A session id is one folder name, while
   * a file id may carry path segments.
   */
  private fun safeDocumentId(candidate: String, allowSlashes: Boolean): String? {
    if (candidate.isEmpty() || candidate.startsWith('/') || candidate.endsWith('/')) {
      return null
    }
    if (!allowSlashes && candidate.contains('/')) {
      return null
    }
    return candidate.takeIf { id -> id.split('/').all { segment -> isSafeSegment(segment) } }
  }

  private fun isSafeSegment(segment: String): Boolean = segment.isNotEmpty() && segment != "." && segment != ".."

  /** The cursor carries the columns the caller asked for, or the documented default set. */
  private fun resolveProjection(
    projection: Array<out String>?,
    fallback: Array<String>,
  ): Array<String> =
    if (projection == null) {
      fallback
    } else {
      Array(projection.size) { index -> projection[index] }
    }

  private fun rootRow(): DocumentRow = DocumentRow(ROOT_ID, ROOT_TITLE, Document.MIME_TYPE_DIR, null)

  private fun sessionRow(session: ManifestSession): DocumentRow =
    DocumentRow(session.id, session.title, Document.MIME_TYPE_DIR, null)

  private fun fileRow(sessionId: String, file: ManifestFile): DocumentRow =
    DocumentRow("$sessionId/${file.id}", file.name, file.mime, file.size)

  /** `<filesDir>/artifacts`, the folder `artifact-mirror.ts` writes into. */
  private val artifactsDirectory: File
    get() = File(requireNotNull(context) { CONTEXT_MISSING_MESSAGE }.filesDir, ARTIFACTS_DIRECTORY_NAME)

  /** One cursor row; `size` is null for a directory and for an unrecorded size. */
  private data class DocumentRow(
    val documentId: String,
    val displayName: String,
    val mimeType: String,
    val size: Long?,
  ) {
    fun addTo(cursor: MatrixCursor) {
      val row = cursor.newRow()
      row.add(Document.COLUMN_DOCUMENT_ID, documentId)
      row.add(Document.COLUMN_DISPLAY_NAME, displayName)
      row.add(Document.COLUMN_MIME_TYPE, mimeType)
      row.add(Document.COLUMN_SIZE, size)
      // Read-only: no FLAG_SUPPORTS_WRITE, FLAG_SUPPORTS_DELETE or
      // FLAG_DIR_SUPPORTS_CREATE, so DocumentsUI offers no write action.
      row.add(Document.COLUMN_FLAGS, READ_ONLY_FLAGS)
    }
  }

  private data class ManifestFile(val id: String, val name: String, val mime: String, val size: Long?)

  private data class ManifestSession(val id: String, val title: String, val files: List<ManifestFile>)

  private data class ArtifactFile(val session: ManifestSession, val entry: ManifestFile)

  /** The manifest file's identity: a rewrite changes at least one of the pair. */
  private data class ManifestStamp(val lastModified: Long, val length: Long)

  companion object {
    /** The single root id the file browser sees. */
    const val ROOT_ID = "kilo"

    /**
     * The provider authority, declared in the module manifest as
     * `${applicationId}.artifacts`; `applicationId` is the app's package name.
     */
    fun authority(context: Context): String = context.packageName + AUTHORITY_SUFFIX

    /** The roots URI DocumentsUI re-queries when the mirror changes. */
    fun rootsUri(context: Context): Uri = DocumentsContract.buildRootsUri(authority(context))

    private const val TAG = "ArtifactsProvider"
    private const val ROOT_TITLE = "Kilo"
    private const val AUTHORITY_SUFFIX = ".artifacts"
    private const val CONTEXT_MISSING_MESSAGE = "Artifacts provider is not attached to a context"
    private const val READ_ONLY_MESSAGE = "The artifact provider is read-only"

    // Layout and manifest keys owned by the mirror
    // (`apps/mobile/src/lib/artifacts/artifact-mirror.ts` and
    // `artifact-mirror-manifest.ts`).
    private const val ARTIFACTS_DIRECTORY_NAME = "artifacts"
    private const val SESSIONS_DIRECTORY_NAME = "sessions"
    private const val MANIFEST_FILE_NAME = "manifest.json"
    private const val DEFAULT_MIME_TYPE = "application/octet-stream"
    private const val READ_MODE = "r"
    private const val READ_ONLY_FLAGS = 0
    private const val SUPPORTED_MANIFEST_VERSION = 1

    /** Column sets the cursor falls back to when the caller passes no projection. */
    private val DEFAULT_ROOT_PROJECTION = arrayOf(
      Root.COLUMN_ROOT_ID,
      Root.COLUMN_DOCUMENT_ID,
      Root.COLUMN_TITLE,
      Root.COLUMN_FLAGS,
      Root.COLUMN_MIME_TYPES,
    )
    private val DEFAULT_DOCUMENT_PROJECTION = arrayOf(
      Document.COLUMN_DOCUMENT_ID,
      Document.COLUMN_DISPLAY_NAME,
      Document.COLUMN_MIME_TYPE,
      Document.COLUMN_SIZE,
      Document.COLUMN_FLAGS,
    )

    private const val KEY_VERSION = "version"
    private const val KEY_SESSIONS = "sessions"
    private const val KEY_ID = "id"
    private const val KEY_TITLE = "title"
    private const val KEY_FILES = "files"
    private const val KEY_NAME = "name"
    private const val KEY_MIME = "mime"
    private const val KEY_SIZE = "size"
  }
}
