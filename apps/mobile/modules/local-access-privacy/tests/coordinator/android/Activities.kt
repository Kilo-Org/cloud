package android.app

import android.os.Bundle
import android.view.Window

open class Activity { val window = Window() }
class Dialog {
  val window: Window? = Window()
  fun create() = Unit
}

class Application {
  interface ActivityLifecycleCallbacks {
    fun onActivityPreCreated(activity: Activity, savedInstanceState: Bundle?)
    fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?)
    fun onActivityResumed(activity: Activity)
    fun onActivityPrePaused(activity: Activity)
    fun onActivityPaused(activity: Activity)
    fun onActivityStopped(activity: Activity)
    fun onActivityStarted(activity: Activity)
    fun onActivitySaveInstanceState(activity: Activity, outState: Bundle)
    fun onActivityDestroyed(activity: Activity)
  }
  lateinit var callbacks: ActivityLifecycleCallbacks
  fun registerActivityLifecycleCallbacks(value: ActivityLifecycleCallbacks) { callbacks = value }
}
