// swift-tools-version:5.10
import PackageDescription

let package = Package(
    name: "TaprootHelper",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "TaprootHelper",
            path: "Sources/TaprootHelper",
            exclude: ["Info.plist"],
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
