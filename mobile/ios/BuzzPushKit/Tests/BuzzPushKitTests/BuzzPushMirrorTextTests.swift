import XCTest

@testable import BuzzPushKit

final class BuzzPushMirrorTextTests: XCTestCase {
  static let channelID = "123e4567-e89b-42d3-a456-426614174000"
  static let agent = String(repeating: "a", count: 64)
  static let requester = String(repeating: "b", count: 64)

  private func community() -> PushLeaseCommunity {
    PushLeaseCommunity(
      id: "community-id", name: "Community", relayUrl: "https://relay.example",
      pubkey: Self.requester,
      policies: [
        PushResolutionPolicy(filter: PushLeaseFilter(kinds: [9, 40002], hTags: [Self.channelID]))
      ])
  }

  private func mirror(_ tags: [[String]], content: String = "Move my 3pm") -> VerifiedNostrEvent {
    VerifiedNostrEvent(
      id: "event-id", pubkey: Self.agent, createdAt: 1, kind: 40002,
      tags: [["h", Self.channelID]] + tags, content: content, sig: "signature")
  }

  private func profile(_ name: String?) -> BuzzPushCachedProfile {
    BuzzPushCachedProfile(
      communityID: "community-id", relayOrigin: "https://relay.example", pubkey: Self.agent,
      displayName: name, pictureHash: nil, avatarPNG: nil, eventID: "profile", eventCreatedAt: 1,
      cachedAt: 1)
  }

  private func resolve(_ event: VerifiedNostrEvent, name: String? = "Agent One")
    -> BuzzPushResolution?
  {
    BuzzPushNotificationResolver.makeResolution(
      event: event, community: community(), profile: profile(name), channel: nil)
  }

  func testRequesterMirrorReadsAsRelayedByTheAgentNeverAsTheRequester() throws {
    let resolution = try XCTUnwrap(resolve(mirror([
      ["buzz-mirror", "tasks", "t1", "1"],
      ["buzz-mirror-author", "requester", Self.requester, "Alex"],
    ])))
    XCTAssertEqual(resolution.title, "Agent One")
    XCTAssertEqual(resolution.body, "Relayed by Agent One (via Kiingo Tasks): Move my 3pm")
    XCTAssertEqual(resolution.senderPubkey, Self.agent)
    XCTAssertFalse(resolution.body.hasPrefix("Alex"))
  }

  func testEmailMirrorSaysEmail() throws {
    let resolution = try XCTUnwrap(resolve(mirror([
      ["buzz-mirror", "email", "m1", "1"],
      ["buzz-mirror-author", "requester", Self.requester, ""],
    ])))
    XCTAssertEqual(resolution.body, "Relayed by Agent One (via email): Move my 3pm")
  }

  func testEitherMirrorTagAloneFailsClosed() throws {
    let authorOnly = try XCTUnwrap(resolve(mirror([
      ["buzz-mirror-author", "requester", Self.requester, ""]
    ])))
    XCTAssertEqual(authorOnly.body, "Relayed by Agent One: Move my 3pm")
    let mirrorOnly = try XCTUnwrap(resolve(mirror([["buzz-mirror", "companion", "c1", "1"]])))
    XCTAssertEqual(mirrorOnly.body, "Relayed by Agent One (via the Companion): Move my 3pm")
    let unknownRole = try XCTUnwrap(resolve(mirror([
      ["buzz-mirror", "teams", "m1", "1"],
      ["buzz-mirror-author", "someone", "", ""],
    ])))
    XCTAssertEqual(unknownRole.body, "Relayed by Agent One (via Teams): Move my 3pm")
  }

  func testAgentMirrorUsesTheAgentForm() throws {
    let resolution = try XCTUnwrap(resolve(mirror([
      ["buzz-mirror", "teams", "m1", "1"],
      ["buzz-mirror-author", "agent", "", ""],
    ])))
    XCTAssertEqual(resolution.body, "Agent One (via Teams): Move my 3pm")
  }

  func testUnknownSignerNameNeverExposesTheRequester() throws {
    let resolution = try XCTUnwrap(resolve(mirror([
      ["buzz-mirror", "sms", "s1", "1"],
      ["buzz-mirror-author", "requester", Self.requester, "Alex"],
    ]), name: nil))
    XCTAssertEqual(resolution.title, "")
    XCTAssertEqual(resolution.body, "Relayed by Agent (via SMS): Move my 3pm")
  }

  func testOrdinaryMessagesKeepTheirPreview() throws {
    let plain = VerifiedNostrEvent(
      id: "event-id", pubkey: Self.agent, createdAt: 1, kind: 9,
      tags: [["h", Self.channelID]], content: "Hello", sig: "signature")
    XCTAssertEqual(try XCTUnwrap(resolve(plain)).body, "Hello")
  }

  func testSurfaceLabelsMatchTheApps() {
    let expected = [
      "email": "email", "teams": "Teams", "sms": "SMS", "web": "web", "voice": "voice call",
      "tasks": "Kiingo Tasks", "companion": "the Companion", "ask": "Kiingo Ask", "fax": "fax",
    ]
    for (surface, label) in expected {
      XCTAssertEqual(BuzzPushMirrorText.surfaceLabel(surface), label, surface)
    }
  }
}
