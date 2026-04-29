import XCTest
@testable import TaprootHelper

final class KeychainStoreTests: XCTestCase {
    /// Use a test-specific service so production Keychain entries are untouched.
    private let testService = "com.taproot.helper.tests"
    private var store: KeychainStore!

    override func setUpWithError() throws {
        store = KeychainStore(service: testService)
        try store.deleteAllForService()
    }

    override func tearDownWithError() throws {
        try store.deleteAllForService()
    }

    func testRoundTrip() throws {
        let id = UUID()
        let bearer = "test-bearer-abcdef0123456789"
        try store.store(workspaceID: id, bearer: bearer)
        XCTAssertEqual(try store.retrieve(workspaceID: id), bearer)
    }

    func testRetrieveMissingReturnsNil() throws {
        XCTAssertNil(try store.retrieve(workspaceID: UUID()))
    }

    func testOverwrite() throws {
        let id = UUID()
        try store.store(workspaceID: id, bearer: "first")
        try store.store(workspaceID: id, bearer: "second")
        XCTAssertEqual(try store.retrieve(workspaceID: id), "second")
    }

    func testDelete() throws {
        let id = UUID()
        try store.store(workspaceID: id, bearer: "to-be-deleted")
        try store.delete(workspaceID: id)
        XCTAssertNil(try store.retrieve(workspaceID: id))
    }

    func testDeleteMissingIsNoOp() throws {
        // Should not throw even when the entry doesn't exist.
        XCTAssertNoThrow(try store.delete(workspaceID: UUID()))
    }

    func testRetrieveAll() throws {
        let id1 = UUID()
        let id2 = UUID()
        try store.store(workspaceID: id1, bearer: "bearer-1")
        try store.store(workspaceID: id2, bearer: "bearer-2")

        let entries = try store.retrieveAll()
        XCTAssertEqual(entries.count, 2)
        let dict = Dictionary(uniqueKeysWithValues: entries)
        XCTAssertEqual(dict[id1], "bearer-1")
        XCTAssertEqual(dict[id2], "bearer-2")
    }

    func testRetrieveAllEmpty() throws {
        XCTAssertEqual(try store.retrieveAll().count, 0)
    }
}
