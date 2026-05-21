import XCTest
@testable import TaprootHelper

/// S84 — exercises the single-instance decision factor that
/// `applicationWillFinishLaunching` consults. The actual NSApp.terminate
/// path is exercised by the manual smoke step in T11-G-SMOKE.md.
final class SingleInstanceTests: XCTestCase {
    func testSingleInstanceAllowsRun() {
        XCTAssertFalse(
            AppDelegate.shouldExitIfDuplicate(currentBundleId: "com.taproot.helper", runningApps: 1),
            "Exactly one instance must not be flagged as duplicate"
        )
    }

    func testDuplicateInstanceFlagged() {
        XCTAssertTrue(
            AppDelegate.shouldExitIfDuplicate(currentBundleId: "com.taproot.helper", runningApps: 2),
            "Two running instances must be flagged for exit"
        )
    }

    func testManyDuplicateInstancesFlagged() {
        XCTAssertTrue(
            AppDelegate.shouldExitIfDuplicate(currentBundleId: "com.taproot.helper", runningApps: 5)
        )
    }

    /// Edge — if NSRunningApplication returns 0 (unlikely but defensive),
    /// the new launch should still proceed rather than exit.
    func testZeroInstancesDoesNotFlag() {
        XCTAssertFalse(
            AppDelegate.shouldExitIfDuplicate(currentBundleId: "com.taproot.helper", runningApps: 0)
        )
    }

    /// Info.plist must declare `LSMultipleInstancesProhibited=false` so the
    /// choice to enforce single-instance at runtime (not via LaunchServices)
    /// is documented in the bundle. Mirrors `InfoPlistTests`' source-file
    /// traversal — the plist is linker-injected and not present on
    /// `Bundle.main` inside xctest.
    func testInfoPlistDeclaresMultipleInstancesNotProhibited() throws {
        let testFile = URL(fileURLWithPath: #filePath)
        let infoPlistURL = testFile
            .deletingLastPathComponent() // TaprootHelperTests/
            .deletingLastPathComponent() // Tests/
            .deletingLastPathComponent() // helper-mac/
            .appendingPathComponent("Sources/TaprootHelper/Info.plist")
        let data = try Data(contentsOf: infoPlistURL)
        let plist = try PropertyListSerialization.propertyList(from: data, format: nil)
        let dict = try XCTUnwrap(plist as? [String: Any])
        let value = dict["LSMultipleInstancesProhibited"] as? Bool
        XCTAssertEqual(value, false, "LSMultipleInstancesProhibited must be explicitly false")
    }
}
