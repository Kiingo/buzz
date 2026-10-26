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

  /// Letters that pass for y, o and u in "You": Cyrillic, Greek, Armenian,
  /// small capitals and the digit zero. Same table as the apps.
  static let youLookalikes: [UInt32: Character] = [
    0x0423: "y", 0x0443: "y", 0x04AE: "y", 0x04AF: "y", 0x03A5: "y", 0x028F: "y", 0x13A9: "y",
    0x041E: "o", 0x043E: "o", 0x039F: "o", 0x03BF: "o", 0x0555: "o", 0x0585: "o", 0x1D0F: "o",
    0x30: "o",
    0x03C5: "u", 0x054D: "u", 0x057D: "u", 0x1D1C: "u", 0x028B: "u",
  ]

  /// Whether a self-asserted name would read as "You", as the apps decide:
  /// NFKC, characters that draw nothing removed (Cf and default-ignorables),
  /// combining marks (Mn, Me) removed, surrounding punctuation, symbols and
  /// spaces trimmed, look-alike letters folded, then compared
  /// case-insensitively.
  static func readsAsYou(_ name: String) -> Bool {
    let visible = name.precomposedStringWithCompatibilityMapping.unicodeScalars.filter {
      switch $0.properties.generalCategory {
      case .format, .nonspacingMark, .enclosingMark: return false
      default: return !$0.properties.isDefaultIgnorableCodePoint
      }
    }
    let scalars = Array(visible)
    func isEdge(_ scalar: Unicode.Scalar) -> Bool {
      switch scalar.properties.generalCategory {
      case .connectorPunctuation, .dashPunctuation, .openPunctuation, .closePunctuation,
        .initialPunctuation, .finalPunctuation, .otherPunctuation, .mathSymbol,
        .currencySymbol, .modifierSymbol, .otherSymbol, .spaceSeparator, .lineSeparator,
        .paragraphSeparator:
        return true
      default:
        return scalar.properties.isWhitespace
      }
    }
    guard let first = scalars.firstIndex(where: { !isEdge($0) }),
      let last = scalars.lastIndex(where: { !isEdge($0) })
    else { return false }
    let folded = String(
      scalars[first...last].map { youLookalikes[$0.value] ?? Character($0) })
    return folded.lowercased() == "you"
  }

  /// The notification body for `tags` and its sanitized `preview`, or nil
  /// when the event is not a mirror. Either mirror tag makes it one. Unless
  /// every author tag has role `agent`, it is a requester mirror (fail
  /// closed). `signerName` is the signer's display name, if known; a
  /// self-asserted name that reads as "You" (`readsAsYou`) reads as "Agent".
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
        return trimmed.isEmpty || readsAsYou(name) ? nil : name
      } ?? "Agent"
    let via = surface.flatMap { $0.isEmpty ? nil : " (via \(surfaceLabel($0)))" } ?? ""
    if agentAuthor && !requester {
      return "\(signer)\(via): \(preview)"
    }
    return "Relayed by \(signer)\(via): \(preview)"
  }
}
