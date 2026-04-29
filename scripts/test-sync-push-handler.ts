/**
 * Stage 1 T11.3 commit 1 — handler unit smoke for POST /sync/push.
 *
 * Boots an `express()` instance with `syncRouter({ requireAuth: stub,
 * getBackend: stub })` mounted on an ephemeral port. Exercises:
 *   - 400s on bad bodies (missing ops, missing path, bad kind, upsert
 *     missing content)
 *   - 200 with mixed per-op results on success
 *   - idempotent delete: NotFoundError on delete → ok:true
 *   - per-op error mapping: NotFoundError/ConflictError/generic →
 *     "not_found"/"conflict"/"internal"
 *
 * No Supabase. Runs in <1s. Lands ahead of the helper-side commits so we
 * can verify the wire protocol without any Swift code.
 *
 * Run: tsx scripts/test-sync-push-handler.ts
 */
import express, { type RequestHandler } from "express";
import type { AddressInfo } from "node:net";
import { syncRouter } from "../src/api/sync.js";
import {
  ConflictError,
  NotFoundError,
  type StorageBackend,
} from "../src/utils/storage.js";

interface RecordedCall {
  method: "writeFile" | "delete";
  path: string;
  content?: string;
}

interface StubBackend extends Pick<StorageBackend, "writeFile" | "delete"> {
  calls: RecordedCall[];
}

function makeStubBackend(
  pathErrors: Map<string, Error> = new Map(),
): StubBackend {
  const calls: RecordedCall[] = [];
  return {
    calls,
    async writeFile(filePath: string, content: string) {
      calls.push({ method: "writeFile", path: filePath, content });
      const err = pathErrors.get(`writeFile:${filePath}`);
      if (err) throw err;
    },
    async delete(filePath: string) {
      calls.push({ method: "delete", path: filePath });
      const err = pathErrors.get(`delete:${filePath}`);
      if (err) throw err;
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
    (req as any).workspaceId = opts.workspaceId ?? "ws_test_0001";
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

async function postPush(
  url: string,
  body: unknown,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${url}/sync/push`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
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

async function run() {
  console.log("test: sync push handler unit smoke\n");

  // 400s — schema rejects bad bodies before handler runs.

  await withServer({ backend: makeStubBackend() }, async (s) => {
    const r = await postPush(s.url, {});
    check("missing ops -> 400", r.status === 400, r);
    checkEq("error code = invalid_body", r.body?.error, "invalid_body");
  });

  await withServer({ backend: makeStubBackend() }, async (s) => {
    const r = await postPush(s.url, { ops: [] });
    check("empty ops array -> 400", r.status === 400, r);
  });

  await withServer({ backend: makeStubBackend() }, async (s) => {
    const r = await postPush(s.url, {
      ops: [{ kind: "upsert", content: "x" }],
    });
    check("upsert missing path -> 400", r.status === 400, r);
  });

  await withServer({ backend: makeStubBackend() }, async (s) => {
    const r = await postPush(s.url, {
      ops: [{ kind: "upsert", path: "a.md" }],
    });
    check("upsert missing content -> 400", r.status === 400, r);
  });

  await withServer({ backend: makeStubBackend() }, async (s) => {
    const r = await postPush(s.url, {
      ops: [{ kind: "patch", path: "a.md" }],
    });
    check("bad kind -> 400", r.status === 400, r);
  });

  // 200 success path.

  await withServer({ backend: makeStubBackend() }, async (s) => {
    const r = await postPush(s.url, {
      ops: [
        { kind: "upsert", path: "a.md", content: "# A" },
        { kind: "delete", path: "b.md" },
      ],
    });
    check("simple batch -> 200", r.status === 200, r);
    checkEq("results length = 2", r.body?.results?.length, 2);
    checkEq("upsert ok=true", r.body?.results?.[0], {
      path: "a.md",
      ok: true,
    });
    checkEq("delete ok=true", r.body?.results?.[1], {
      path: "b.md",
      ok: true,
    });
  });

  await withServer({ backend: makeStubBackend() }, async (s) => {
    const r = await postPush(s.url, {
      ops: [
        {
          kind: "upsert",
          path: "with-mtime.md",
          content: "x",
          mtime: "2026-04-29T05:00:00.000Z",
        },
      ],
    });
    check("upsert with valid mtime -> 200", r.status === 200, r);
  });

  await withServer({ backend: makeStubBackend() }, async (s) => {
    const r = await postPush(s.url, {
      ops: [
        {
          kind: "upsert",
          path: "bad-mtime.md",
          content: "x",
          mtime: "yesterday",
        },
      ],
    });
    check("upsert with bad mtime -> 400", r.status === 400, r);
  });

  // Idempotent delete: NotFoundError on the backend should surface as ok:true.

  await withServer(
    {
      backend: makeStubBackend(
        new Map([["delete:gone.md", new NotFoundError("gone.md")]]),
      ),
    },
    async (s) => {
      const r = await postPush(s.url, {
        ops: [{ kind: "delete", path: "gone.md" }],
      });
      check("idempotent delete -> 200", r.status === 200, r);
      checkEq("idempotent delete result", r.body?.results?.[0], {
        path: "gone.md",
        ok: true,
      });
    },
  );

  // Per-op error mapping (writeFile path).

  await withServer(
    {
      backend: makeStubBackend(
        new Map([["writeFile:nope.md", new NotFoundError("nope.md")]]),
      ),
    },
    async (s) => {
      const r = await postPush(s.url, {
        ops: [{ kind: "upsert", path: "nope.md", content: "x" }],
      });
      check("writeFile NotFoundError -> 200 batch", r.status === 200, r);
      checkEq(
        "error mapped to not_found",
        r.body?.results?.[0]?.error,
        "not_found",
      );
      checkEq("ok=false", r.body?.results?.[0]?.ok, false);
    },
  );

  await withServer(
    {
      backend: makeStubBackend(
        new Map([["writeFile:dup.md", new ConflictError("conflict")]]),
      ),
    },
    async (s) => {
      const r = await postPush(s.url, {
        ops: [{ kind: "upsert", path: "dup.md", content: "x" }],
      });
      check("writeFile ConflictError -> 200 batch", r.status === 200, r);
      checkEq(
        "error mapped to conflict",
        r.body?.results?.[0]?.error,
        "conflict",
      );
    },
  );

  await withServer(
    {
      backend: makeStubBackend(
        new Map([["writeFile:boom.md", new Error("disk full")]]),
      ),
    },
    async (s) => {
      const r = await postPush(s.url, {
        ops: [{ kind: "upsert", path: "boom.md", content: "x" }],
      });
      check("writeFile generic error -> 200 batch", r.status === 200, r);
      checkEq(
        "error mapped to internal",
        r.body?.results?.[0]?.error,
        "internal",
      );
      checkEq("detail propagates", r.body?.results?.[0]?.detail, "disk full");
    },
  );

  // Mixed batch: success + failure + success — one failure must not reject
  // the rest. This is the load-bearing invariant for batched pushes.

  await withServer(
    {
      backend: makeStubBackend(
        new Map([["writeFile:fail.md", new Error("nope")]]),
      ),
    },
    async (s) => {
      const r = await postPush(s.url, {
        ops: [
          { kind: "upsert", path: "ok.md", content: "ok" },
          { kind: "upsert", path: "fail.md", content: "fail" },
          { kind: "delete", path: "bye.md" },
        ],
      });
      check("mixed batch -> 200", r.status === 200, r);
      checkEq("3 results", r.body?.results?.length, 3);
      checkEq("op #1 ok", r.body?.results?.[0]?.ok, true);
      checkEq("op #2 failed", r.body?.results?.[1]?.ok, false);
      checkEq("op #2 internal", r.body?.results?.[1]?.error, "internal");
      checkEq("op #3 ok", r.body?.results?.[2]?.ok, true);
    },
  );

  // Backend resolution failure → top-level 500 (NOT a per-op result).

  await withServer(
    {
      backend: makeStubBackend(),
    },
    async (s) => {
      // Replace the resolver mid-test by remounting? Simpler: dedicated
      // server with throwing resolver inline.
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
        const r = await postPush(inner.url, {
          ops: [{ kind: "upsert", path: "a.md", content: "x" }],
        });
        check("getBackend throw -> 500", r.status === 500, r);
        checkEq("error code = server_error", r.body?.error, "server_error");
      } finally {
        await inner.close();
      }
      // Suppress unused-var warning: makeStubBackend() above kept shape for
      // the with-server signature but the inline server is what we test.
      void s;
    },
  );

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
