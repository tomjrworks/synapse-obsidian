/**
 * Unit tests for src/api/respond-error.ts.
 *
 * Tests respondError + logErrorWithId in isolation with a fake Express
 * Response. No server, no env. Run: tsx scripts/test-respond-error.ts
 */
import { respondError, logErrorWithId } from "../src/api/respond-error.js";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    failures.push(`${name}: ${JSON.stringify(detail)}`);
    console.log(`  ✗ ${name}  →  ${JSON.stringify(detail)}`);
  }
}

type FakeRes = {
  headersSent: boolean;
  statusCode?: number;
  body?: unknown;
  status: (n: number) => FakeRes;
  json: (b: unknown) => FakeRes;
};

function makeRes(headersSent = false): FakeRes {
  const r: FakeRes = {
    headersSent,
    status(n) {
      this.statusCode = n;
      return this;
    },
    json(b) {
      this.body = b;
      return this;
    },
  };
  return r;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function captureConsoleError<T>(fn: () => T): {
  result: T;
  calls: unknown[][];
} {
  const original = console.error;
  const calls: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    calls.push(args);
  };
  try {
    const result = fn();
    return { result, calls };
  } finally {
    console.error = original;
  }
}

console.log("\nrespondError unit tests\n");

// 1. Sets correct status + JSON body shape with stable error code
{
  const res = makeRes();
  captureConsoleError(() =>
    respondError(res as never, 500, "boom", new Error("internal detail")),
  );
  const body = res.body as { error: string; request_id: string };
  check("sets status code from arg", res.statusCode === 500, res.statusCode);
  check(
    "body.error is the stable code (not err.message)",
    body.error === "boom",
    body.error,
  );
  check(
    "body has request_id field",
    typeof body.request_id === "string",
    typeof body.request_id,
  );
}

// 2. request_id is UUID-shaped
{
  const res = makeRes();
  captureConsoleError(() => respondError(res as never, 400, "bad", "oops"));
  const body = res.body as { request_id: string };
  check(
    "request_id is UUID-shaped",
    UUID_RE.test(body.request_id),
    body.request_id,
  );
}

// 3. Logs to console.error with code + request_id
{
  const res = makeRes();
  const err = new Error("boom");
  const { calls } = captureConsoleError(() =>
    respondError(res as never, 500, "boom_code", err, {
      logPrefix: "test-prefix",
    }),
  );
  const body = res.body as { request_id: string };
  const logged = calls.length === 1 ? String(calls[0][0]) : "";
  check("console.error called once", calls.length === 1, calls.length);
  check("log line contains code", logged.includes("code=boom_code"), logged);
  check(
    "log line contains matching request_id",
    logged.includes(`request_id=${body.request_id}`),
    logged,
  );
  check("log line uses logPrefix", logged.includes("[test-prefix]"), logged);
  check(
    "raw err passed as second console.error arg",
    calls[0]?.[1] === err,
    calls[0]?.[1],
  );
}

// 4. Merges opts.extra without overriding error/request_id
{
  const res = makeRes();
  captureConsoleError(() =>
    respondError(res as never, 400, "invalid_step", undefined, {
      extra: {
        allowed: ["a", "b"],
        // Attempt to override; should NOT win.
        error: "should-not-win",
        request_id: "should-not-win",
      },
    }),
  );
  const body = res.body as Record<string, unknown>;
  check("extra fields merged", Array.isArray(body.allowed), body.allowed);
  check(
    "extra cannot override error",
    body.error === "invalid_step",
    body.error,
  );
  check(
    "extra cannot override request_id",
    typeof body.request_id === "string" &&
      UUID_RE.test(body.request_id as string),
    body.request_id,
  );
}

// 5. Bails silently when res.headersSent === true
{
  const res = makeRes(true);
  const { calls } = captureConsoleError(() =>
    respondError(res as never, 500, "late", new Error("after headers")),
  );
  check(
    "no second res.json call when headers already sent",
    res.body === undefined,
    res.body,
  );
  check(
    "still logs the error after headers sent",
    calls.length === 1 && String(calls[0][0]).includes("after headers sent"),
    calls,
  );
}

// 6. Accepts undefined err without crashing
{
  const res = makeRes();
  let threw = false;
  captureConsoleError(() => {
    try {
      respondError(res as never, 500, "no_err");
    } catch {
      threw = true;
    }
  });
  check("undefined err does not throw", threw === false);
  check(
    "body still produced for undefined err",
    (res.body as { error: string }).error === "no_err",
  );
}

console.log("\nlogErrorWithId unit tests\n");

// 7. Returns a UUID-shaped request_id
{
  const { result } = captureConsoleError(() =>
    logErrorWithId(new Error("x"), "some_code"),
  );
  check("logErrorWithId returns UUID", UUID_RE.test(result), result);
}

// 8. Logs with code + request_id + prefix
{
  const { result, calls } = captureConsoleError(() =>
    logErrorWithId(new Error("x"), "batch_fail", "sync/push"),
  );
  const logged = calls.length === 1 ? String(calls[0][0]) : "";
  check(
    "log line contains code and matching request_id",
    logged.includes("code=batch_fail") &&
      logged.includes(`request_id=${result}`),
    logged,
  );
  check("log line uses prefix", logged.includes("[sync/push]"), logged);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
