// swift-tools-version:5.10
import PackageDescription

let package = Package(
    name: "TaprootHelper",
    platforms: [.macOS(.v13)],
    dependencies: [
        .package(url: "https://github.com/sparkle-project/Sparkle", from: "2.6.0"),
    ],
    targets: [
        .executableTarget(
            name: "TaprootHelper",
            dependencies: [
                .product(name: "Sparkle", package: "Sparkle"),
            ],
            path: "Sources/TaprootHelper",
            exclude: ["Info.plist"],
            // Info.plist is injected as a Mach-O __TEXT,__info_plist section (not a bundle resource)
            // because SwiftPM executableTargets don't produce .app bundles. Bundle.main
            // .object(forInfoDictionaryKey:) still resolves against this section — relevant
            // because Sparkle reads SUFeedURL/SUPublicEDKey/etc. via that API.
            linkerSettings: [
                .unsafeFlags([
                    "-Xlinker", "-sectcreate",
                    "-Xlinker", "__TEXT",
                    "-Xlinker", "__info_plist",
                    "-Xlinker", "Sources/TaprootHelper/Info.plist",
                ])
            ]
        ),
        .testTarget(
            name: "TaprootHelperTests",
            dependencies: ["TaprootHelper"],
            path: "Tests/TaprootHelperTests"
        ),
    ]
)
