package expo.modules.kiloappactions

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import org.json.JSONObject

/**
 * The four entry points, and the translation from an Intent to the shared
 * contract payload.
 *
 * This is addressing, not action logic: the names, the slugs, and which extra
 * carries which contract field. What an action does — the destination it
 * resolves to, the session it starts — lives in the JS contract and its
 * dispatcher.
 */
internal object KiloActionContract {
  /** The URL scheme and host the VIEW entry point answers (`app.config.ts`). */
  const val SCHEME = "kiloapp"
  const val HOST = "actions"

  const val ACTION_START_AGENT = "com.kilocode.kiloapp.action.START_AGENT"
  const val ACTION_OPEN_NEEDS_INPUT = "com.kilocode.kiloapp.action.OPEN_NEEDS_INPUT"
  const val ACTION_OPEN_SESSION = "com.kilocode.kiloapp.action.OPEN_SESSION"
  const val ACTION_OPEN_PULL_REQUEST = "com.kilocode.kiloapp.action.OPEN_PULL_REQUEST"

  /** Present when the caller wants the dispatcher's result back. */
  const val EXTRA_RESULT = "com.kilocode.kiloapp.extra.RESULT"
  const val EXTRA_PROMPT = "com.kilocode.kiloapp.extra.PROMPT"
  const val EXTRA_REPOSITORY = "com.kilocode.kiloapp.extra.REPOSITORY"
  const val EXTRA_SESSION_ID = "com.kilocode.kiloapp.extra.SESSION_ID"
  const val EXTRA_PULL_REQUEST = "com.kilocode.kiloapp.extra.PULL_REQUEST"

  /**
   * The contract slug of each entry point (`APP_ACTION_SLUGS`, s1). The URL
   * form of the same action is the contract's canonical spelling:
   *
   * - `kiloapp:///actions/start-agent?prompt=fix+the+build`
   * - `kiloapp:///actions/open-needs-input`
   * - `kiloapp:///actions/open-session?sessionId=ses_1`
   * - `kiloapp:///actions/open-pull-request?pullRequest=https://github.com/o/r/pull/7`
   *
   * The manifest's VIEW filter matches the `kiloapp://actions/<slug>` spelling
   * the exported entry point answers; [slugFromUrl] accepts both.
   */
  val SLUG_BY_ACTION: Map<String, String> = mapOf(
    ACTION_START_AGENT to "start-agent",
    ACTION_OPEN_NEEDS_INPUT to "open-needs-input",
    ACTION_OPEN_SESSION to "open-session",
    ACTION_OPEN_PULL_REQUEST to "open-pull-request"
  )

  /** Each contract field and the extra that carries it. */
  private val FIELDS = listOf(
    "prompt" to EXTRA_PROMPT,
    "repository" to EXTRA_REPOSITORY,
    "sessionId" to EXTRA_SESSION_ID,
    "pullRequest" to EXTRA_PULL_REQUEST
  )

  /**
   * The contract payload for an intent, in the JSON-object form
   * `parseAppActionPayload` accepts, or null when the intent names no action.
   *
   * An extra wins over the query of a VIEW intent. A field the caller did not
   * send is left out: the contract decides whether the request is complete, so
   * the native side never builds a half-validated request of its own.
   */
  fun payload(intent: Intent): String? {
    val slug = slugOf(intent) ?: return null
    val json = JSONObject().put("action", slug)
    for ((field, extra) in FIELDS) {
      val value = intent.getStringExtra(extra) ?: intent.data?.getQueryParameter(field)
      if (value != null) {
        json.put(field, value)
      }
    }
    return json.toString()
  }

  /** The contract slug of an intent: its custom action, or its action URL. */
  private fun slugOf(intent: Intent): String? {
    val action = intent.action ?: return null
    if (action == Intent.ACTION_VIEW) {
      return slugFromUrl(intent.data?.toString())
    }
    return SLUG_BY_ACTION[action]
  }

  /**
   * The slug of the entry point's own `kiloapp://actions/<slug>` spelling, and
   * of the contract's empty-host spelling (`/actions/<slug>` after the scheme),
   * and null for any other URL. A slug the contract does not define is null too.
   */
  private fun slugFromUrl(raw: String?): String? {
    val uri = raw?.let { Uri.parse(it) } ?: return null
    if (uri.scheme != SCHEME) {
      return null
    }
    val segments = uri.pathSegments.orEmpty().filter { it.isNotEmpty() }
    val slug = when {
      uri.host == HOST -> segments.singleOrNull()
      uri.host.isNullOrEmpty() && segments.size == 2 && segments.first() == HOST -> segments[1]
      else -> null
    }
    return slug?.takeIf(SLUG_BY_ACTION::containsValue)
  }
}

/**
 * The exported entry point for the four app actions.
 *
 * It is addressable from outside the app: `adb shell am start`, the Assistant,
 * a launcher shortcut, or any other app. It translates the intent into the
 * contract payload and hands it to the shared JS dispatcher. A caller that
 * passes [KiloActionContract.EXTRA_RESULT] gets the dispatcher's real outcome
 * back through `setResult`, even when the app had to start first: the async
 * result arrives through `completeAppAction`, which this activity waits on
 * instead of a fire-and-forget acknowledgement.
 */
class KiloActionActivity : Activity() {
  private val main = Handler(Looper.getMainLooper())
  private var settled = false
  private var awaitsResult = false
  private var waitingFor: String? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    handle(intent)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    handle(intent)
  }

  private fun handle(intent: Intent?) {
    settled = false
    awaitsResult = intent?.hasExtra(KiloActionContract.EXTRA_RESULT) == true
    val payload = intent?.let(KiloActionContract::payload)
    if (payload == null) {
      finishWith(null)
      return
    }
    if (awaitsResult) {
      waitingFor = payload
      AppActionDispatcher.await(payload) { result -> finishWith(result) }
      main.postDelayed({ finishWith(null) }, RESULT_TIMEOUT_MS)
    }
    if (AppActionDispatcher.dispatch(payload)) {
      if (!awaitsResult) {
        finish()
      }
      return
    }
    // The JS runtime is not up yet. The dispatcher buffered the payload, so
    // bring the app up: registration drains it through the same dispatcher and
    // answers the waiting caller with `completeAppAction`.
    packageManager.getLaunchIntentForPackage(packageName)?.let { launched -> startActivity(launched) }
    if (!awaitsResult) {
      finish()
    }
  }

  /** The dispatcher's result, or null when it did not answer in time. */
  private fun finishWith(result: String?) {
    if (settled) {
      return
    }
    settled = true
    main.removeCallbacksAndMessages(null)
    waitingFor?.let(AppActionDispatcher::abandon)
    waitingFor = null
    if (awaitsResult) {
      val reply = Intent().putExtra(KiloActionContract.EXTRA_RESULT, result)
      val code = if (result == null) Activity.RESULT_CANCELED else Activity.RESULT_OK
      setResult(code, reply)
    }
    finish()
  }

  private companion object {
    /** A cold start has to boot the app before the dispatcher can answer. */
    const val RESULT_TIMEOUT_MS = 15_000L
  }
}
