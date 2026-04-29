import XCTest
@testable import TaprootHelper

@MainActor
final class WorkspaceWatcherTests: XCTestCase {
    private var tmpDir: URL!
    private var watcher: WorkspaceWatcher?

    override func setUpWithError() throws {
        let base = FileManager.default.temporaryDirectory
        tmpDir = base.appendingPathComponent("taproot-watcher-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        watcher?.stop()
        watcher = nil
        if let tmpDir, FileManager.default.fileExists(atPath: tmpDir.path) {
            try? FileManager.default.removeItem(at: tmpDir)
        }
    }

    // MARK: - helpers

    final class EventBox {
        var events: [FileChangeEvent] = []
    }

    /// Builds a watcher pointed at `tmpDir`, accumulates all events into `box`,
    /// and fulfills `expectation` once `predicate(box.events)` is true.
    private func startWatcher(
        expectation: XCTestExpectation,
        predicate: @escaping ([FileChangeEvent]) -> Bool,
        box: EventBox
    ) {
        let exp = expectation
        let w = WorkspaceWatcher(
            workspaceID: UUID(),
            folder: tmpDir,
            latency: 0.3
        ) { events in
            box.events.append(contentsOf: events)
            if predicate(box.events) {
                exp.fulfill()
            }
        }
        w.start()
        watcher = w
    }

    // MARK: - tests

    func testFireOnFileCreate() throws {
        let target = tmpDir.appendingPathComponent("a.md")
        let exp = expectation(description: "create event")
        let box = EventBox()
        startWatcher(expectation: exp, predicate: { events in
            events.contains { $0.kind == .created && $0.path.lastPathComponent == "a.md" }
        }, box: box)

        try "hello".write(to: target, atomically: true, encoding: .utf8)
        wait(for: [exp], timeout: 3.0)

        let createEvent = box.events.first { $0.path.lastPathComponent == "a.md" && $0.kind == .created }
        XCTAssertNotNil(createEvent)
        XCTAssertNotNil(createEvent?.mtime)
    }

    func testFireOnFileModify() throws {
        let target = tmpDir.appendingPathComponent("b.md")
        // Non-atomic create: writes in place, no temp+rename. Atomic writes fire
        // Renamed flags from FSEvents and would derive as `.created`, not `.modified`.
        try Data("v1".utf8).write(to: target)

        let exp = expectation(description: "modify event")
        let box = EventBox()
        startWatcher(expectation: exp, predicate: { events in
            events.contains { $0.kind == .modified && $0.path.lastPathComponent == "b.md" }
        }, box: box)

        // Brief delay so FSEvents distinguishes the modify from the pre-existing file.
        Thread.sleep(forTimeInterval: 0.5)
        let fh = try FileHandle(forWritingTo: target)
        try fh.seekToEnd()
        try fh.write(contentsOf: Data("-appended".utf8))
        try fh.close()
        wait(for: [exp], timeout: 3.0)
    }

    func testFireOnFileDelete() throws {
        let target = tmpDir.appendingPathComponent("c.md")
        try "doomed".write(to: target, atomically: true, encoding: .utf8)

        let exp = expectation(description: "delete event")
        let box = EventBox()
        startWatcher(expectation: exp, predicate: { events in
            events.contains { $0.kind == .deleted && $0.path.lastPathComponent == "c.md" }
        }, box: box)

        Thread.sleep(forTimeInterval: 0.5)
        try FileManager.default.removeItem(at: target)
        wait(for: [exp], timeout: 3.0)

        let deleteEvent = box.events.first { $0.path.lastPathComponent == "c.md" && $0.kind == .deleted }
        XCTAssertNotNil(deleteEvent)
        XCTAssertNil(deleteEvent?.mtime)
    }

    func testCoalescesMultipleWritesInWindow() throws {
        let exp = expectation(description: "all 3 events delivered")
        let box = EventBox()
        startWatcher(expectation: exp, predicate: { events in
            let names = Set(events.map { $0.path.lastPathComponent })
            return names.isSuperset(of: ["x.md", "y.md", "z.md"])
        }, box: box)

        try "1".write(to: tmpDir.appendingPathComponent("x.md"), atomically: true, encoding: .utf8)
        try "2".write(to: tmpDir.appendingPathComponent("y.md"), atomically: true, encoding: .utf8)
        try "3".write(to: tmpDir.appendingPathComponent("z.md"), atomically: true, encoding: .utf8)

        wait(for: [exp], timeout: 3.0)
    }

    func testMissingFolderDoesNotCrash() {
        let missing = tmpDir.appendingPathComponent("does-not-exist")
        let box = EventBox()
        let w = WorkspaceWatcher(
            workspaceID: UUID(),
            folder: missing,
            latency: 0.3
        ) { events in
            box.events.append(contentsOf: events)
        }
        w.start()
        watcher = w

        // Negative-time expectation: nothing should fire within 1s.
        let exp = expectation(description: "no events")
        exp.isInverted = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
            if !box.events.isEmpty { exp.fulfill() }
        }
        wait(for: [exp], timeout: 1.5)

        XCTAssertTrue(box.events.isEmpty)
    }

    func testStopIsIdempotent() {
        let w = WorkspaceWatcher(
            workspaceID: UUID(),
            folder: tmpDir,
            latency: 0.3
        ) { _ in }
        w.start()
        w.stop()
        w.stop() // must not crash
        watcher = w
    }

    func testIgnoresHiddenFiles() throws {
        let exp = expectation(description: "no event for hidden file")
        exp.isInverted = true
        let box = EventBox()
        startWatcher(expectation: exp, predicate: { events in
            events.contains { $0.path.lastPathComponent == ".DS_Store" }
        }, box: box)

        try "hidden".write(to: tmpDir.appendingPathComponent(".DS_Store"), atomically: true, encoding: .utf8)
        wait(for: [exp], timeout: 1.5)

        XCTAssertFalse(box.events.contains { $0.path.lastPathComponent == ".DS_Store" })
    }

    func testRenameProducesPairedEvents() throws {
        let oldURL = tmpDir.appendingPathComponent("old.md")
        let newURL = tmpDir.appendingPathComponent("new.md")
        try "renameme".write(to: oldURL, atomically: true, encoding: .utf8)

        let exp = expectation(description: "rename pair")
        let box = EventBox()
        startWatcher(expectation: exp, predicate: { events in
            // Relaxed: at-least-one delete for old AND at-least-one create for new.
            let hasDeleteOld = events.contains { $0.kind == .deleted && $0.path.lastPathComponent == "old.md" }
            let hasCreateNew = events.contains { $0.kind == .created && $0.path.lastPathComponent == "new.md" }
            return hasDeleteOld && hasCreateNew
        }, box: box)

        Thread.sleep(forTimeInterval: 0.5)
        try FileManager.default.moveItem(at: oldURL, to: newURL)
        wait(for: [exp], timeout: 3.0)
    }
}
