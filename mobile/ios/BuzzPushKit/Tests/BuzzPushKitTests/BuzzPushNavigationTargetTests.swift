import Foundation
import Testing

@testable import BuzzPushKit

@Test func `Round-trip opaque navigation target through notification user info`() {
  let target = BuzzPushNavigationTarget(
    eventID: "MESSAGE-ID",
    communityID: "community-id",
    channelID: "CHANNEL/GENERAL"
  )

  #expect(
    BuzzPushNavigationTarget.decodeIfPresent(
      from: [BuzzPushNavigationTarget.userInfoKey: target.userInfoValue]
    ) == target
  )
  #expect(target.eventID == "MESSAGE-ID")
  #expect(target.channelID == "CHANNEL/GENERAL")
}

@Test func `Reject incomplete or malformed navigation target`() {
  #expect(
    BuzzPushNavigationTarget.decodeIfPresent(
      from: [
        BuzzPushNavigationTarget.userInfoKey: [
          "event_id": "message-id",
          "community_id": "community-id",
        ]
      ]
    ) == nil
  )

  #expect(
    BuzzPushNavigationTarget.decodeIfPresent(
      from: [
        BuzzPushNavigationTarget.userInfoKey: [
          "event_id": "",
          "community_id": "community-id",
          "channel_id": "channel-id",
        ]
      ]
    ) == nil
  )

  #expect(
    BuzzPushNavigationTarget.decodeIfPresent(
      from: [
        BuzzPushNavigationTarget.userInfoKey: [
          "event_id": "message-id",
          "community_id": "community-id",
          "channel_id": "",
        ]
      ]
    ) == nil
  )
}

@Test func `Round-trip guest-access notification target without a channel`() throws {
  let target = try #require(
    BuzzPushNavigationTarget.guestNotification(
      eventID: "EVENT-ID",
      communityID: "community-id",
      kind: 46_040
    )
  )

  #expect(target.channelID == nil)
  #expect(target.guestNotificationKind == 46_040)
  #expect(
    target.userInfoValue == [
      "event_id": "EVENT-ID",
      "community_id": "community-id",
      "guest_kind": "46040",
    ]
  )
  #expect(
    BuzzPushNavigationTarget.decodeIfPresent(
      from: [BuzzPushNavigationTarget.userInfoKey: target.userInfoValue]
    ) == target
  )
}

@Test func `Reject guest targets for other kinds or with a channel`() {
  #expect(
    BuzzPushNavigationTarget.guestNotification(
      eventID: "event-id",
      communityID: "community-id",
      kind: 46_041
    ) == nil
  )
  for raw: [String: String] in [
    ["event_id": "event-id", "community_id": "community-id", "guest_kind": "46041"],
    ["event_id": "event-id", "community_id": "community-id", "guest_kind": "046040"],
    ["event_id": "event-id", "community_id": "community-id", "guest_kind": "9"],
    [
      "event_id": "event-id", "community_id": "community-id",
      "channel_id": "channel-id", "guest_kind": "46040",
    ],
  ] {
    #expect(
      BuzzPushNavigationTarget.decodeIfPresent(
        from: [BuzzPushNavigationTarget.userInfoKey: raw]
      ) == nil
    )
  }
}

@Test func `Buffer preserves cold-start target until consumed`() {
  let first = BuzzPushNavigationTarget(
    eventID: String(repeating: "a", count: 64),
    communityID: "community-id",
    channelID: "123e4567-e89b-42d3-a456-426614174000"
  )
  let second = BuzzPushNavigationTarget(
    eventID: String(repeating: "b", count: 64),
    communityID: "community-id",
    channelID: "123e4567-e89b-42d3-a456-426614174000"
  )
  let buffer = BuzzPushNavigationBuffer()

  buffer.record(first)
  buffer.remove(ifMatching: second)
  #expect(buffer.peek() == first)
  #expect(buffer.take() == first)
  #expect(buffer.take() == nil)
}
