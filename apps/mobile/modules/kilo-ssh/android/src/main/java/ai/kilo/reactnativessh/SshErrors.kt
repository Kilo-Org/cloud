package ai.kilo.reactnativessh

import ai.kilo.reactnativessh.uniffi.SshException
import expo.modules.kotlin.exception.CodedException

/**
 * Hands a Rust failure to JavaScript with the core's error category as `code`.
 *
 * The categories are the generated variants of [SshException], so this `when`
 * stays exhaustive: a new Rust category breaks the build here instead of
 * reaching JavaScript as `Protocol`.
 */
internal fun SshException.toCodedException(): CodedException =
  CodedException(code(), message.orEmpty(), this)

private fun SshException.code(): String = when (this) {
  is SshException.Network -> "Network"
  is SshException.Timeout -> "Timeout"
  is SshException.HostKeyRejected -> "HostKeyRejected"
  is SshException.AuthFailed -> "AuthFailed"
  is SshException.AuthCancelled -> "AuthCancelled"
  is SshException.UnsupportedAlgorithm -> "UnsupportedAlgorithm"
  is SshException.KeyParse -> "KeyParse"
  is SshException.WrongPassphrase -> "WrongPassphrase"
  is SshException.InvalidExport -> "InvalidExport"
  is SshException.ChannelClosed -> "ChannelClosed"
  is SshException.Protocol -> "Protocol"
  is SshException.KeyGeneration -> "KeyGeneration"
  is SshException.NotFound -> "NotFound"
  is SshException.PermissionDenied -> "PermissionDenied"
  is SshException.Cancelled -> "Cancelled"
  is SshException.Forwarding -> "Forwarding"
  is SshException.LocalIo -> "LocalIo"
}
