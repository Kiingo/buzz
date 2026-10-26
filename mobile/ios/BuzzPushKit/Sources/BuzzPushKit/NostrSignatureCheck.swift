import CSecp256k1

/// The BIP-340 check the Flutter relay session calls through Dart FFI, so
/// the app verifies every relay event with the same libsecp256k1 as push.
public enum NostrSignatureCheck {
  /// `int32_t check(const uint8_t sig[64], const uint8_t id[32],
  /// const uint8_t xonlyKey[32])`: 1 when `sig` is the key's BIP-340
  /// signature of `id`, otherwise 0. It holds no state and is safe to call
  /// from any thread.
  public typealias CheckFunction = @convention(c) (
    UnsafePointer<UInt8>?, UnsafePointer<UInt8>?, UnsafePointer<UInt8>?
  ) -> Int32

  public static let check: CheckFunction = { signature, id, key in
    guard let signature, let id, let key else { return 0 }
    var parsed = secp256k1_xonly_pubkey()
    guard secp256k1_xonly_pubkey_parse(secp256k1_context_static, &parsed, key) == 1 else {
      return 0
    }
    return secp256k1_schnorrsig_verify(secp256k1_context_static, signature, id, 32, &parsed)
  }

  /// The address of `check`, for the Flutter side to bind with FFI. The
  /// library's self-test runs first (see `NostrSchnorr.staticContextTested`).
  public static var address: Int {
    _ = NostrSchnorr.staticContextTested
    return Int(bitPattern: unsafeBitCast(check, to: UnsafeRawPointer.self))
  }
}
