package androidx.fragment.app

import android.app.Activity
import android.app.Dialog
import android.os.Bundle

open class Fragment {
  val childFragmentManager = FragmentManager()
  var activity: Activity? = null
  fun requireActivity() = requireNotNull(activity)
}
class DialogFragment : Fragment() {
  val showsDialog = true
  val dialog: Dialog? = Dialog()
}
class FragmentActivity : Activity() { val supportFragmentManager = FragmentManager() }
class FragmentManager {
  open class FragmentLifecycleCallbacks {
    open fun onFragmentActivityCreated(fm: FragmentManager, f: Fragment, savedInstanceState: Bundle?) = Unit
    open fun onFragmentStarted(fm: FragmentManager, f: Fragment) = Unit
    open fun onFragmentDestroyed(fm: FragmentManager, f: Fragment) = Unit
  }
  val fragments = mutableListOf<Fragment>()
  val callbacks = mutableListOf<FragmentLifecycleCallbacks>()
  fun registerFragmentLifecycleCallbacks(value: FragmentLifecycleCallbacks, recursive: Boolean) {
    check(recursive)
    callbacks.add(value)
  }
  fun unregisterFragmentLifecycleCallbacks(value: FragmentLifecycleCallbacks) { callbacks.remove(value) }
}
