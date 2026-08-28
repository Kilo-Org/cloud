package expo.modules.localaccessprivacy

import android.app.Application
import android.content.Context
import expo.modules.core.interfaces.ApplicationLifecycleListener
import expo.modules.core.interfaces.Package

class LocalAccessPrivacyPackage : Package {
  override fun createApplicationLifecycleListeners(context: Context?): List<ApplicationLifecycleListener> =
    listOf(object : ApplicationLifecycleListener {
      override fun onCreate(application: Application) {
        // Application callbacks do not wait for Expo's loadAppReady lifecycle forwarding.
        LocalAccessPrivacy.install(application)
      }
    })
}
