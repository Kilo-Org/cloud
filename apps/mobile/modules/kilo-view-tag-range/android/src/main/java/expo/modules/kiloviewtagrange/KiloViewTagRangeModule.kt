package expo.modules.kiloviewtagrange

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * The range of React view tags a JavaScript instance hands out.
 *
 * React Native allocates view tags in JavaScript, from the first tag of every instance, while
 * Android keeps state keyed by those tags for the life of the process. Its text measurement
 * caches the measured text of each text input under the input's tag, and drops that entry
 * when an input carrying the same tag is collected. A reloaded instance therefore reissues
 * tags the previous instance's inputs still hold, and one of those inputs being collected
 * leaves a live input without a measurement. Every instance claims its own range instead, so
 * no two instances in one process name the same tag.
 */
class KiloViewTagRangeModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("KiloViewTagRange")

    // Called once per JavaScript instance, before its first render.
    Function("claimRange") { ViewTagRanges.claimBase() }
  }
}

private object ViewTagRanges {
  // Each instance may allocate this many tags before its range is spent: an instance that
  // mounts and recycles far more views than this in one life would start aliasing the next
  // range, which is the state the ranges exist to avoid.
  private const val RANGE_SIZE = 1 shl 21

  private var claimed = 0

  /**
   * The first tag offset of the next range, or 0 for the platform default when this process
   * has claimed every range it can address.
   */
  @Synchronized
  fun claimBase(): Int {
    val base = claimed.toLong() * RANGE_SIZE
    if (base > Int.MAX_VALUE - RANGE_SIZE) {
      return 0
    }
    claimed += 1
    return base.toInt()
  }
}