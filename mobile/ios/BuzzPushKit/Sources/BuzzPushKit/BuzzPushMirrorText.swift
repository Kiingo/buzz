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
    case "companion": return "Kiingo Companion"
    case "ask": return "Kiingo Ask"
    default: return surface
    }
  }

  /// The notification body for `tags` and its sanitized `preview`, or nil
  /// when the event is not a mirror. Either mirror tag makes it one. Unless
  /// every author tag has role `agent`, it is a requester mirror (fail
  /// closed). `signerName` is the signer's display name, if known.
  static func body(tags: [[String]], preview: String, signerName: String?) -> String? {
    var mirrored = false
    var surface: String?
    var agentAuthor = false
    var requester = false
    for tag in tags {
      guard let name = tag.first else { continue }
      if name == mirrorTag {
        mirrored = true
        if surface == nil, tag.count >= 2, !tag[1].isEmpty { surface = tag[1] }
      } else if name == authorTag {
        mirrored = true
        if tag.count >= 2, tag[1] == "agent" { agentAuthor = true } else { requester = true }
      }
    }
    guard mirrored else { return nil }
    let signer = signerName.flatMap { $0.isEmpty ? nil : $0 } ?? "Agent"
    let via = surface.map { " (via \(surfaceLabel($0)))" } ?? ""
    if agentAuthor && !requester {
      return "\(signer)\(via): \(preview)"
    }
    return "Relayed by \(signer)\(via): \(preview)"
  }
}
