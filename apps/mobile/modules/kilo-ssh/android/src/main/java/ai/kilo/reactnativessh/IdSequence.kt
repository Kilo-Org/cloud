package ai.kilo.reactnativessh

import java.util.concurrent.atomic.AtomicLong

/** Process-local identifiers for sessions, shells and prompt requests. */
internal class IdSequence(private val prefix: String) {
  private val counter = AtomicLong()

  fun next(): String = "$prefix${counter.incrementAndGet()}"
}
