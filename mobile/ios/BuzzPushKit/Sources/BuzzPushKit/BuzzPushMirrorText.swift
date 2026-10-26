import Foundation

/// Notification text for a mirrored agent DM line (`docs/agent-dm-markers.md`
/// §1), so a pushed mirror never reads as the requester's own message.
///
/// The labels and plain-text forms mirror the shared display rule (desktop
/// `mirrorDisplay.ts`, mobile `agent_dm_mirror_display.dart`, vectors in
/// `test-fixtures/mirror-display.json`). The extension has no verified DM
/// roster or requester name, so a requester mirror always takes the rule's
/// signer form: "Relayed by <agent> (via <surface>): text".
enum BuzzPushMirrorText {
  static let mirrorTag = "buzz-mirror"
  static let authorTag = "buzz-mirror-author"

  /// The surface a mirror came from, as a noun. Same labels as the apps.
  static func surfaceLabel(_ surface: String) -> String {
    switch surface {
    case "email": return "email"
    case "teams": return "Teams"
    case "sms": return "SMS"
    case "web": return "web"
    case "voice": return "voice call"
    case "tasks": return "Kiingo Tasks"
    case "companion": return "the Companion"
    case "ask": return "Kiingo Ask"
    default: return surface
    }
  }

  /// Whether `value` is a well-formed surface token (the apps' `SURFACE_RE`,
  /// `^[a-z][a-z0-9_-]{0,31}$`). Anything else never reaches the body.
  static func isSurface(_ value: String) -> Bool {
    let lower = UInt8(ascii: "a")...UInt8(ascii: "z")
    let digit = UInt8(ascii: "0")...UInt8(ascii: "9")
    let bytes = Array(value.utf8)
    guard (1...32).contains(bytes.count), lower.contains(bytes[0]) else { return false }
    return bytes.allSatisfy { byte in
      lower.contains(byte) || digit.contains(byte)
        || byte == UInt8(ascii: "_") || byte == UInt8(ascii: "-")
    }
  }

  /// The notification body for `tags` and its sanitized `preview`, or nil
  /// when the event is not a mirror. Either mirror tag makes it one. Unless
  /// every author tag has role `agent`, it is a requester mirror (fail
  /// closed). `signerName` is the signer's display name, if known; a name of
  /// "You" (any case, after trimming) is self-asserted and reads as "Agent".
  /// A malformed surface value is left out rather than shown.
  static func body(tags: [[String]], preview: String, signerName: String?) -> String? {
    var mirrored = false
    var surface: String?
    var agentAuthor = false
    var requester = false
    for tag in tags {
      guard let name = tag.first else { continue }
      if name == mirrorTag {
        mirrored = true
        if surface == nil { surface = tag.count >= 2 && isSurface(tag[1]) ? tag[1] : "" }
      } else if name == authorTag {
        mirrored = true
        if tag.count >= 2, tag[1] == "agent" { agentAuthor = true } else { requester = true }
      }
    }
    guard mirrored else { return nil }
    let signer =
      signerName.flatMap { name in
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty || trimmed.lowercased() == "you" ? nil : name
      } ?? "Agent"
    let via = surface.flatMap { $0.isEmpty ? nil : " (via \(surfaceLabel($0)))" } ?? ""
    if agentAuthor && !requester {
      return "\(signer)\(via): \(preview)"
    }
    return "Relayed by \(signer)\(via): \(preview)"
  }
}
