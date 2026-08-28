package expo.modules.localaccessprivacy

import android.os.Looper
import com.facebook.react.bridge.UiThreadUtil
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import java.util.concurrent.FutureTask

class PrivacyGateAction : Record {
  @Field var id: String = ""
  @Field var label: String = ""
  @Field var enabled: Boolean = false
}

class PrivacyGate : Record {
  @Field var title: String = ""
  @Field var message: String = ""
  @Field var actions: List<PrivacyGateAction> = emptyList()
}

internal fun <T> onPrivacyMain(body: () -> T): T {
  if (Looper.myLooper() == Looper.getMainLooper()) return body()
  val task = FutureTask(body)
  UiThreadUtil.runOnUiThread(task)
  return task.get()
}

class LocalAccessPrivacyModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("LocalAccessPrivacy")
    Events("onVisibilityChange", "onGateAction")

    OnCreate {
      onPrivacyMain {
        // This attachment precedes the shell's successful arm, and thus authenticated Modal creation.
        LocalAccessPrivacy.attach(requireNotNull(appContext.reactContext))
        LocalAccessPrivacy.emit = { name, payload -> sendEvent(name, payload) }
      }
    }
    OnDestroy {
      onPrivacyMain {
        // Reloading JavaScript does not establish that authenticated windows have unmounted.
        LocalAccessPrivacy.cover()
        LocalAccessPrivacy.detach()
        LocalAccessPrivacy.emit = null
      }
    }
    Function("arm") { onPrivacyMain { LocalAccessPrivacy.arm() } }
    Function("disarm") { onPrivacyMain { LocalAccessPrivacy.disarm() } }
    Function("cover") { onPrivacyMain { LocalAccessPrivacy.cover() } }
    Function("getSnapshot") { onPrivacyMain { LocalAccessPrivacy.snapshot() } }
    Function("publishVisibility") { generation: Long ->
      onPrivacyMain { LocalAccessPrivacy.publish(generation) }
    }
    Function("isForegroundAllowed") { onPrivacyMain { LocalAccessPrivacy.foregroundAllowed() } }
    Function("setGate") { generation: Long, gate: PrivacyGate? ->
      onPrivacyMain { LocalAccessPrivacy.setGate(generation, gate) }
    }
    AsyncFunction("announce") { message: String, generation: Long, gate: Boolean ->
      // The UI-thread boundary rechecks after the native queue wait, not only at JS invocation.
      LocalAccessPrivacy.announce(message, generation, gate)
    }.runOnQueue(Queues.MAIN)
  }
}
