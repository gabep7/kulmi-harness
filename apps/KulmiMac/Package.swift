// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "KulmiMac",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "KulmiMac", targets: ["KulmiMac"])],
    targets: [
        .executableTarget(
            name: "KulmiMac",
            path: "Sources/KulmiMac"
        )
    ]
)
