package expo.modules.kilofontscale

import android.content.ComponentCallbacks
import android.content.Context
import android.content.res.Configuration
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * The live system font scale, which React Native never reports while the app is
 * in the foreground: `DeviceInfoModule` caches `fontScale` at construction and
 * refreshes it only when the host resumes, so `Dimensions` and
 * `useWindowDimensions().fontScale` keep the launch value until then.
 *
 * The app handles a font-size change in place (`android:configChanges` includes
 * `fontScale`), so nothing recreates the activity to re-read the value. This
 * module reads it straight from the current resources and emits the change as
 * it happens, which is what lets text re-measure at the new scale without a
 * restart.
 */
class KiloFontScaleModule : Module() {
  private var registration: ComponentCallbacks? = null

  override fun definition() = ModuleDefinition {
    Name("KiloFontScale")

    Events("onFontScaleChange")

    Function("getFontScale") { currentFontScale() }

    OnCreate {
      val context = appContext.reactContext?.applicationContext ?: return@OnCreate
      val callbacks =
        object : ComponentCallbacks {
          override fun onConfigurationChanged(newConfig: Configuration) {
            sendEvent("onFontScaleChange", mapOf("fontScale" to newConfig.fontScale.toDouble()))
          }

          override fun onLowMemory() = Unit
        }
      registration = callbacks
      context.registerComponentCallbacks(callbacks)
    }

    OnDestroy {
      val context = appContext.reactContext?.applicationContext
      val callbacks = registration
      if (context != null && callbacks != null) {
        context.unregisterComponentCallbacks(callbacks)
      }
      registration = null
    }
  }

  private fun currentFontScale(): Double =
    (appContext.reactContext?.resources?.configuration?.fontScale ?: 1.0f).toDouble()
}
