// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "BuzzPushKit",
    platforms: [.iOS(.v15), .macOS(.v12)],
    products: [
        .library(name: "BuzzPushKit", targets: ["BuzzPushKit"])
    ],
    dependencies: [],
    targets: [
        .target(
            name: "CSecp256k1",
            sources: ["vendor/src/secp256k1.c", "vendor/src/precomputed_ecmult.c", "vendor/src/precomputed_ecmult_gen.c"],
            publicHeadersPath: "include",
            cSettings: [.define("ENABLE_MODULE_EXTRAKEYS"), .define("ENABLE_MODULE_SCHNORRSIG")]
        ),
        .target(
            name: "BuzzPushKit",
            dependencies: ["CSecp256k1"]
        ),
        .testTarget(
            name: "BuzzPushKitTests",
            dependencies: [
                "BuzzPushKit",
                "CSecp256k1",
            ],
            resources: [.copy("Fixtures/app_attest_transcripts.json"), .copy("CryptoFixtures/bip340.csv")]
        ),
    ]
)
