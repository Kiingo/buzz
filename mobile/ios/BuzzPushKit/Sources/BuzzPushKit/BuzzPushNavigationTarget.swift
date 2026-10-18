import Foundation

/// A stable destination attached by the notification service extension after
/// it resolves and verifies the event that produced a push wake.
///
/// Exactly one of [channelID] and [guestNotificationKind] is set: channel
/// events open their message (optionally inside its direct parent's thread),
/// while owner-addressed agent guest-access notifications (which carry no
/// channel) open the owner review in the app.
public struct BuzzPushNavigationTarget: Codable, Equatable, Sendable {
  public static let userInfoKey = "buzz_push_navigation"

  /// Guest-access notification kinds that open the owner review on tap:
  /// approval requested (46040) and alert (46042).
  public static let guestNotificationKinds: Set<Int> = [46_040, 46_042]

  public let eventID: String
  public let communityID: String
  public let channelID: String?

  /// Direct parent whose thread contains the target reply, matching Inbox.
  public let threadRootID: String?
  public let guestNotificationKind: Int?

  public init(
    eventID: String, communityID: String, channelID: String, threadRootID: String? = nil
  ) {
    self.eventID = eventID
    self.communityID = communityID
    self.channelID = channelID
    self.threadRootID = threadRootID
    self.guestNotificationKind = nil
  }

  private init(eventID: String, communityID: String, guestNotificationKind: Int) {
    self.eventID = eventID
    self.communityID = communityID
    self.channelID = nil
    self.threadRootID = nil
    self.guestNotificationKind = guestNotificationKind
  }

  /// A target for an owner-addressed guest-access notification, or `nil` for
  /// any other kind.
  public static func guestNotification(
    eventID: String,
    communityID: String,
    kind: Int
  ) -> BuzzPushNavigationTarget? {
    guard guestNotificationKinds.contains(kind), !eventID.isEmpty, !communityID.isEmpty
    else { return nil }
    return BuzzPushNavigationTarget(
      eventID: eventID,
      communityID: communityID,
      guestNotificationKind: kind
    )
  }

  public var userInfoValue: [String: String] {
    var value = [
      "event_id": eventID,
      "community_id": communityID,
    ]
    if let channelID {
      value["channel_id"] = channelID
    }
    value["thread_root_id"] = threadRootID
    if let guestNotificationKind {
      value["guest_kind"] = String(guestNotificationKind)
    }
    return value
  }

  static func threadRootID(in tags: [[String]]) -> String? {
    // Inbox opens broadcast replies in the channel and other replies in their
    // direct parent's thread, even when the NIP-10 root names an outer thread.
    if tags.contains(where: { $0.count >= 2 && $0[0] == "broadcast" && $0[1] == "1" }) {
      return nil
    }
    // Match relay ingest: the last valid 64-character ASCII-hex reply ID wins.
    // A later malformed marker must not hide an earlier valid parent.
    return tags.last(where: { tag in
      guard tag.count >= 4, tag[0] == "e", tag[3] == "reply" else { return false }
      let bytes = tag[1].utf8
      return bytes.count == 64 && bytes.allSatisfy {
        (48...57).contains($0) || (65...70).contains($0) || (97...102).contains($0)
      }
    })?[1].lowercased()
  }

  /// Decodes a target without trusting other fields from the APNs payload.
  public static func decodeIfPresent(
    from userInfo: [AnyHashable: Any]
  ) -> BuzzPushNavigationTarget? {
    guard let raw = userInfo[userInfoKey] as? [String: Any],
      Set(raw.keys).isSubset(
        of: ["event_id", "community_id", "channel_id", "thread_root_id", "guest_kind"]),
      let eventID = raw["event_id"] as? String,
      let communityID = raw["community_id"] as? String,
      !eventID.isEmpty,
      !communityID.isEmpty
    else {
      return nil
    }
    if let rawChannel = raw["channel_id"] {
      guard let channelID = rawChannel as? String, !channelID.isEmpty,
        raw["guest_kind"] == nil
      else { return nil }
      if let rawThread = raw["thread_root_id"] {
        guard let thread = rawThread as? String, !thread.isEmpty else { return nil }
      }
      return BuzzPushNavigationTarget(
        eventID: eventID,
        communityID: communityID,
        channelID: channelID,
        threadRootID: raw["thread_root_id"] as? String
      )
    }
    guard raw["thread_root_id"] == nil,
      let rawKind = raw["guest_kind"] as? String,
      let kind = Int(rawKind),
      String(kind) == rawKind
    else {
      return nil
    }
    return guestNotification(eventID: eventID, communityID: communityID, kind: kind)
  }

}

/// Thread-safe one-item buffer spanning notification delivery and Flutter
/// engine startup during a cold notification launch.
public final class BuzzPushNavigationBuffer: @unchecked Sendable {
  private let lock = NSLock()
  private var target: BuzzPushNavigationTarget?

  public init() {}

  public func record(_ target: BuzzPushNavigationTarget) {
    lock.lock()
    self.target = target
    lock.unlock()
  }

  public func peek() -> BuzzPushNavigationTarget? {
    lock.lock()
    defer { lock.unlock() }
    return target
  }

  public func take() -> BuzzPushNavigationTarget? {
    lock.lock()
    defer { lock.unlock() }
    let current = target
    target = nil
    return current
  }

  public func remove(ifMatching expected: BuzzPushNavigationTarget) {
    lock.lock()
    defer { lock.unlock() }
    if target == expected {
      target = nil
    }
  }
}
