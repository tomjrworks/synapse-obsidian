/**
 * Stage 1 T11.4 — handler unit smoke for GET /sync/pull.
 *
 * Boots an `express()` instance with `syncRouter({ requireAuth: stub,
 * getBackend: stub })` mounted on an ephemeral port. Exercises:
 *   - 400s on bad queries (bad since/since_id format, half-cursor, bad limit)
 *   - 200 with no cursor → alive rows only, ASC ordering, next cursor
 *   - 200 with cursor → tuple-comparison correctness incl. soft-deleted rows
 *     (verifies the IQ-1 `delete()` modified_at bump round-trips)
 *   - pagination drain (limit=2 across a 5-row page set)
 *   - inline content present for alive rows, absent for deleted rows
 *   - empty result echoes input cursor (helper polls forever the same way)
 *   - backend resolution failure / listChanged throw → top-level 500
 *
 * No Supabase. Runs in <1s. Lands ahead of the helper-side commits so we can
 * verify the wire protocol without any Swift code.
 *
 * Run: tsx scripts/test-sync-pull-handler.ts
 */
import express, { type RequestHandler } from "express";
import type { AddressInfo } from "node:net";
import { syncRouter } from "../src/api/sync.js";
import {
  type ListChangedResult,
  type PullCursor,
  type StorageBackend,
  type VaultFileChange,
} from "../src/utils/storage.js";

interface SeedRow {
  id: string;
  path: string;
  size: number;
  modifiedAt: string; // ISO8601
  deleted: boolean;
  content?: string;
}

interface StubBackend extends Pick<
  StorageBackend,
  "writeFile" | "delete" | "listChanged"
> {
  rows: SeedRow[];
  calls: { cursor: PullCursor | null; limit: number }[];
}

// Stub `listChanged` that mirrors SupabaseEncryptedMirrorBackend.listChanged
// semantics: ASC sort by (modifiedAt, id); cursor=null skips deleted rows;
// cursor returns rows with strict tuple > cursor; next cursor = last row's
// (modifiedAt, id), or echoes input on empty page.
function makeStubBackend(rows: SeedRow[] = []): StubBackend {
  const calls: { cursor: PullCursor | null; limit: number }[] = [];
  return {
    rows,
    calls,
    async writeFile() {
      throw new Error("writeFile not used by pull handler smoke");
    },
    async delete() {
      throw new Error("delete not used by pull handler smoke");
    },
    async listChanged(
      cursor: PullCursor | null,
      limit: number,
    ): Promise<ListChangedResult> {
      calls.push({ cursor, limit });

      const sorted = [...rows].sort((a, b) => {
        if (a.modifiedAt < b.modifiedAt) return -1;
        if (a.modifiedAt > b.modifiedAt) return 1;
        if (a.id < b.id) return -1;
        if (a.id > b.id) return 1;
        return 0;
      });

      let filtered: SeedRow[];
      if (cursor) {
        filtered = sorted.filter((r) => {
          if (r.modifiedAt > cursor.modifiedAt) return true;
          if (r.modifiedAt === cursor.modifiedAt && r.id > cursor.id)
            return true;
          return false;
        });
      } else {
        filtered = sorted.filter((r) => !r.deleted);
      }

      const page = filtered.slice(0, limit);

      const files: VaultFileChange[] = page.map((r) => {
        const base = {
          path: r.path,
          size: r.size,
          modifiedAt: r.modifiedAt,
          id: r.id,
          deleted: r.deleted,
        };
        if (r.deleted) return base;
        return { ...base, content: r.content };
      });

      let next: PullCursor | null = cursor;
      if (page.length > 0) {
        const last = page[page.length - 1];
        next = { modifiedAt: last.modifiedAt, id: last.id };
      }

      return { files, next };
    },
  };
}

interface ServerHandle {
  url: string;
  close: () => Promise<void>;
}

interface MountOpts {
  workspaceId?: string;
  backend: StubBackend;
}

async function startTestServer(opts: MountOpts): Promise<ServerHandle> {
  const app = express();
  app.use(express.json({ limit: "10mb" }));

  const stubAuth: RequestHandler = (req, _res, next) => {
    (req as any).workspaceId = opts.workspaceId ?? "ws_test_pull";
    next();
  };

  app.use(
    syncRouter({
      requireAuth: stubAuth,
      getBackend: async () => opts.backend,
    }),
  );

  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((res, rej) =>
            server.close((err) => (err ? rej(err) : res())),
          ),
      });
    });
  });
}

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    const msg = detail !== undefined ? ` (${JSON.stringify(detail)})` : "";
    failures.push(`${name}${msg}`);
    console.error(`  ✗ ${name}${msg}`);
  }
}

function checkEq<T>(name: string, actual: T, expected: T): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(name, a === e, a === e ? undefined : { expected, actual });
}

async function getPull(
  url: string,
  params: Record<string, string | number | undefined> = {},
): Promise<{ status: number; body: any }> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) qs.set(k, String(v));
  }
  const full = qs.toString() ? `${url}/sync/pull?${qs}` : `${url}/sync/pull`;
  const res = await fetch(full, { method: "GET" });
  const text = await res.text();
  let json: any = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
  }
  return { status: res.status, body: json };
}

async function withServer<T>(
  opts: MountOpts,
  fn: (s: ServerHandle) => Promise<T>,
): Promise<T> {
  const server = await startTestServer(opts);
  try {
    return await fn(server);
  } finally {
    await server.close();
  }
}

// Stable, sortable IDs. Real rows use UUID; tests just need lex-ordered
// strings that pass the zod uuid regex.
const ID = {
  a: "00000000-0000-4000-8000-000000000001",
  b: "00000000-0000-4000-8000-000000000002",
  c: "00000000-0000-4000-8000-000000000003",
  d: "00000000-0000-4000-8000-000000000004",
  e: "00000000-0000-4000-8000-000000000005",
};

async function run() {
  console.log("test: sync pull handler unit smoke\n");

  // ---------- 400s — schema rejects bad queries before handler runs.

  await withServer({ backend: makeStubBackend() }, async (s) => {
    const r = await getPull(s.url, { since: "not-a-date" });
    check("bad since format -> 400", r.status === 400, r);
    checkEq("error code = invalid_query", r.body?.error, "invalid_query");
  });

  await withServer({ backend: makeStubBackend() }, async (s) => {
    const r = await getPull(s.url, { since: "2026-04-29T05:00:00.000Z" });
    check("since without since_id -> 400", r.status === 400, r);
  });

  await withServer({ backend: makeStubBackend() }, async (s) => {
    const r = await getPull(s.url, { since_id: ID.a });
    check("since_id without since -> 400", r.status === 400, r);
  });

  await withServer({ backend: makeStubBackend() }, async (s) => {
    const r = await getPull(s.url, { limit: 0 });
    check("limit=0 -> 400", r.status === 400, r);
  });

  await withServer({ backend: makeStubBackend() }, async (s) => {
    const r = await getPull(s.url, { limit: 501 });
    check("limit=501 -> 400", r.status === 400, r);
  });

  await withServer({ backend: makeStubBackend() }, async (s) => {
    const r = await getPull(s.url, {
      since: "2026-04-29T05:00:00.000Z",
      since_id: "not-a-uuid",
    });
    check("bad since_id format -> 400", r.status === 400, r);
  });

  // Regression: PostgREST emits timestamptz as `+00:00` and the helper
  // round-trips the cursor verbatim. Zod's plain `.datetime()` rejects that
  // form; `.datetime({ offset: true })` is required.
  await withServer({ backend: makeStubBackend() }, async (s) => {
    const r = await getPull(s.url, {
      since: "2026-04-29T05:00:00+00:00",
      since_id: ID.a,
    });
    check(
      "+00:00 timezone offset accepted (PostgREST round-trip)",
      r.status === 200,
      r,
    );
  });

  // ---------- 200 with no cursor — initial pull semantics.
  // Alive rows only, ordered ASC by (modifiedAt, id), next = last row's tuple.

  await withServer(
    {
      backend: makeStubBackend([
        {
          id: ID.b,
          path: "b.md",
          size: 2,
          modifiedAt: "2026-04-29T05:00:01.000Z",
          deleted: false,
          content: "B",
        },
        {
          id: ID.a,
          path: "a.md",
          size: 1,
          modifiedAt: "2026-04-29T05:00:00.000Z",
          deleted: false,
          content: "A",
        },
        {
          id: ID.c,
          path: "c.md",
          size: 3,
          modifiedAt: "2026-04-29T05:00:02.000Z",
          deleted: true,
        },
      ]),
    },
    async (s) => {
      const r = await getPull(s.url, {});
      check("no-cursor -> 200", r.status === 200, r);
      checkEq("alive rows only (deleted excluded)", r.body?.files?.length, 2);
      checkEq("ASC order: a then b", r.body?.files?.[0]?.path, "a.md");
      checkEq(
        "next_since = last alive row modifiedAt",
        r.body?.next_since,
        "2026-04-29T05:00:01.000Z",
      );
      checkEq("next_since_id = last alive row id", r.body?.next_since_id, ID.b);
    },
  );

  // ---------- 200 with cursor — tuple-comparison correctness.
  // Two rows share modifiedAt; cursor at (T, ID.a) must surface (T, ID.b)
  // but NOT (T, ID.a).

  await withServer(
    {
      backend: makeStubBackend([
        {
          id: ID.a,
          path: "a.md",
          size: 1,
          modifiedAt: "2026-04-29T05:00:00.000Z",
          deleted: false,
          content: "A",
        },
        {
          id: ID.b,
          path: "b.md",
          size: 1,
          modifiedAt: "2026-04-29T05:00:00.000Z",
          deleted: false,
          content: "B",
        },
        {
          id: ID.c,
          path: "c.md",
          size: 1,
          modifiedAt: "2026-04-29T05:00:01.000Z",
          deleted: false,
          content: "C",
        },
      ]),
    },
    async (s) => {
      const r = await getPull(s.url, {
        since: "2026-04-29T05:00:00.000Z",
        since_id: ID.a,
      });
      check("cursor at boundary -> 200", r.status === 200, r);
      checkEq("tuple > cursor returns 2 rows (b, c)", r.body?.files?.length, 2);
      checkEq(
        "row 0 = b (same modifiedAt, id > since_id)",
        r.body?.files?.[0]?.path,
        "b.md",
      );
      checkEq(
        "row 1 = c (modifiedAt > since)",
        r.body?.files?.[1]?.path,
        "c.md",
      );
    },
  );

  // ---------- 200 with deletions — IQ-1 round-trip.
  // Cursor pull surfaces soft-deleted rows when modified_at advances.

  await withServer(
    {
      backend: makeStubBackend([
        {
          id: ID.a,
          path: "alive.md",
          size: 1,
          modifiedAt: "2026-04-29T05:00:00.000Z",
          deleted: false,
          content: "A",
        },
        {
          id: ID.b,
          path: "tombstone.md",
          size: 0,
          modifiedAt: "2026-04-29T05:00:01.000Z",
          deleted: true,
        },
      ]),
    },
    async (s) => {
      const r = await getPull(s.url, {
        since: "2026-04-29T04:00:00.000Z",
        since_id: ID.a,
      });
      check("cursor pull -> 200", r.status === 200, r);
      checkEq("returns 2 rows incl. tombstone", r.body?.files?.length, 2);
      checkEq("tombstone deleted=true", r.body?.files?.[1]?.deleted, true);
    },
  );

  // ---------- Pagination drain (limit=2 across 5 rows).

  await withServer(
    {
      backend: makeStubBackend([
        {
          id: ID.a,
          path: "1.md",
          size: 1,
          modifiedAt: "2026-04-29T05:00:00.000Z",
          deleted: false,
          content: "1",
        },
        {
          id: ID.b,
          path: "2.md",
          size: 1,
          modifiedAt: "2026-04-29T05:00:01.000Z",
          deleted: false,
          content: "2",
        },
        {
          id: ID.c,
          path: "3.md",
          size: 1,
          modifiedAt: "2026-04-29T05:00:02.000Z",
          deleted: false,
          content: "3",
        },
        {
          id: ID.d,
          path: "4.md",
          size: 1,
          modifiedAt: "2026-04-29T05:00:03.000Z",
          deleted: false,
          content: "4",
        },
        {
          id: ID.e,
          path: "5.md",
          size: 1,
          modifiedAt: "2026-04-29T05:00:04.000Z",
          deleted: false,
          content: "5",
        },
      ]),
    },
    async (s) => {
      const r1 = await getPull(s.url, { limit: 2 });
      check("page1 -> 200", r1.status === 200, r1);
      checkEq("page1 length = 2", r1.body?.files?.length, 2);
      checkEq(
        "page1 next_since = row 2 modifiedAt",
        r1.body?.next_since,
        "2026-04-29T05:00:01.000Z",
      );
      checkEq("page1 next_since_id = row 2 id", r1.body?.next_since_id, ID.b);

      const r2 = await getPull(s.url, {
        limit: 2,
        since: r1.body.next_since,
        since_id: r1.body.next_since_id,
      });
      checkEq("page2 length = 2", r2.body?.files?.length, 2);
      checkEq("page2 row 0 = 3.md", r2.body?.files?.[0]?.path, "3.md");
    },
  );

  // ---------- Inline content present/absent.

  await withServer(
    {
      backend: makeStubBackend([
        {
          id: ID.a,
          path: "alive.md",
          size: 5,
          modifiedAt: "2026-04-29T05:00:00.000Z",
          deleted: false,
          content: "hello",
        },
        {
          id: ID.b,
          path: "tomb.md",
          size: 0,
          modifiedAt: "2026-04-29T05:00:01.000Z",
          deleted: true,
        },
      ]),
    },
    async (s) => {
      const r = await getPull(s.url, {
        since: "2026-04-28T00:00:00.000Z",
        since_id: ID.a,
      });
      checkEq(
        "alive row has inline content",
        r.body?.files?.[0]?.content,
        "hello",
      );
      check(
        "deleted row has no content key",
        r.body?.files?.[1]?.content === undefined,
        r.body?.files?.[1],
      );
      checkEq("alive row deleted=false", r.body?.files?.[0]?.deleted, false);
    },
  );

  // ---------- Empty result echoes input cursor.

  await withServer({ backend: makeStubBackend([]) }, async (s) => {
    const r1 = await getPull(s.url, {});
    check("empty no-cursor -> 200", r1.status === 200, r1);
    checkEq("empty next_since null", r1.body?.next_since, null);
    checkEq("empty next_since_id null", r1.body?.next_since_id, null);

    const r2 = await getPull(s.url, {
      since: "2026-04-29T05:00:00.000Z",
      since_id: ID.a,
    });
    checkEq(
      "empty cursor pull echoes since",
      r2.body?.next_since,
      "2026-04-29T05:00:00.000Z",
    );
    checkEq("empty cursor pull echoes since_id", r2.body?.next_since_id, ID.a);
  });

  // ---------- Backend resolution failure → 500.

  {
    const app = express();
    app.use(express.json({ limit: "10mb" }));
    const stubAuth: RequestHandler = (req, _res, next) => {
      (req as any).workspaceId = "ws_x";
      next();
    };
    app.use(
      syncRouter({
        requireAuth: stubAuth,
        getBackend: async () => {
          throw new Error("kek_unwrap_failed");
        },
      }),
    );
    const inner = await new Promise<ServerHandle>((resolve) => {
      const server = app.listen(0, () => {
        const port = (server.address() as AddressInfo).port;
        resolve({
          url: `http://127.0.0.1:${port}`,
          close: () =>
            new Promise<void>((res, rej) =>
              server.close((err) => (err ? rej(err) : res())),
            ),
        });
      });
    });
    try {
      const r = await getPull(inner.url, {});
      check("getBackend throw -> 500", r.status === 500, r);
      checkEq("error code = server_error", r.body?.error, "server_error");
    } finally {
      await inner.close();
    }
  }

  // ---------- listChanged throw → 500.

  {
    const throwing: StubBackend = {
      rows: [],
      calls: [],
      async writeFile() {
        throw new Error("not used");
      },
      async delete() {
        throw new Error("not used");
      },
      async listChanged() {
        throw new Error("query_blew_up");
      },
    };
    await withServer({ backend: throwing }, async (s) => {
      const r = await getPull(s.url, {});
      check("listChanged throw -> 500", r.status === 500, r);
    });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.error("\nfailures:");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
}

run().catch((err) => {
  console.error("test suite threw:", err);
  process.exit(1);
});
