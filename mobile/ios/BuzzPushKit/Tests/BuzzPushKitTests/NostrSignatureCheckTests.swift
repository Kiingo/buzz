import Foundation
import XCTest

@testable import BuzzPushKit

final class NostrSignatureCheckTests: XCTestCase {
  /// The check, called through the address the Flutter side binds, gives
  /// the official BIP-340 answers for every 32-byte message.
  func testOfficialBIP340VectorsThroughTheExportedAddress() throws {
    let check = unsafeBitCast(
      try XCTUnwrap(UnsafeRawPointer(bitPattern: NostrSignatureCheck.address)),
      to: NostrSignatureCheck.CheckFunction.self)
    let url = try XCTUnwrap(Bundle.module.url(forResource: "bip340", withExtension: "csv"))
    let rows = try String(contentsOf: url, encoding: .utf8).split(whereSeparator: \.isNewline)
      .dropFirst()
    var checked = 0
    for row in rows {
      let columns = row.split(separator: ",", omittingEmptySubsequences: false).map(String.init)
      let message = try XCTUnwrap(VerifiedNostrEvent.hexBytes(columns[4]))
      guard message.count == 32 else { continue }
      let key = try XCTUnwrap(VerifiedNostrEvent.hexBytes(columns[2]))
      let signature = try XCTUnwrap(VerifiedNostrEvent.hexBytes(columns[5]))
      XCTAssertEqual(
        check(signature, message, key), columns[6] == "TRUE" ? 1 : 0, "vector \(columns[0])")
      checked += 1
    }
    XCTAssertEqual(checked, 15)
    XCTAssertEqual(check(nil, nil, nil), 0)
  }
}
