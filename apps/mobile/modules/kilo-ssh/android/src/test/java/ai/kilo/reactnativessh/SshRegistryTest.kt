package ai.kilo.reactnativessh

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Job
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SshRegistryTest {
  @Test
  fun disconnectAllCancelsConnectingJobsAndAuthenticationRequests() {
    val connect = Job()
    val hostKey = CompletableDeferred<Boolean>()
    val prompts = CompletableDeferred<List<String>?>()
    SshRegistry.beginConnect("pending", connect)
    SshRegistry.putHostKeyRequest("pending", "host-key", hostKey)
    SshRegistry.putPromptRequest("pending", "prompts", prompts)

    SshRegistry.disconnectAll()

    assertTrue(connect.isCancelled)
    assertTrue(hostKey.isCompleted)
    assertTrue(prompts.isCompleted)
    assertEquals(null, SshRegistry.hostKeyRequest("host-key"))
    assertEquals(null, SshRegistry.promptRequest("prompts"))
    assertTrue(SshRegistry.sessionRecords().isEmpty())
    assertFalse(SshRegistry.putHostKeyRequest("pending", "late-key", CompletableDeferred()))
    assertFalse(SshRegistry.putPromptRequest("pending", "late-prompts", CompletableDeferred()))

    val next = Job()
    SshRegistry.beginConnect("next", next)
    assertFalse(next.isCancelled)
    SshRegistry.abandonConnect("next")
    next.cancel()
  }
}
