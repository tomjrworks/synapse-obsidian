/**
 * Strip HTML tags and decode common entities to get plain text.
 * Intentionally simple — the AI will process the content during ingest anyway.
 */
export function htmlToText(html: string): string {
  let text = html;

  text = text.replace(/<script[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, "");
  text = text.replace(/<nav[\s\S]*?<\/nav>/gi, "");
  text = text.replace(/<footer[\s\S]*?<\/footer>/gi, "");
  text = text.replace(/<header[\s\S]*?<\/header>/gi, "");

  text = text.replace(/<\/?(p|div|br|h[1-6]|li|tr|blockquote)[^>]*>/gi, "\n");
  text = text.replace(/<\/?(ul|ol|table|thead|tbody)[^>]*>/gi, "\n");

  text = text.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n");
  text = text.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n");
  text = text.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n");

  text = text.replace(/<[^>]+>/g, "");

  text = text.replace(/&amp;/g, "&");
  text = text.replace(/&lt;/g, "<");
  text = text.replace(/&gt;/g, ">");
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&nbsp;/g, " ");
  text = text.replace(/&#(\d+);/g, (_m, code) =>
    String.fromCharCode(parseInt(code, 10)),
  );

  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n{3,}/g, "\n\n");
  text = text.trim();

  return text;
}

import { Agent, fetch as undiciFetch } from "undici";

const USER_AGENT =
  "Mozilla/5.0 (compatible; Taproot/1.0; +https://github.com/tomjrworks/synapse-obsidian)";

export interface FetchedUrl {
  body: string;
  title: string | null;
}

// H4 (05-01) / H2 (04-30): SSRF blocklist helpers.
// DNS-resolve the hostname and reject any address that maps to a private,
// loopback, link-local, or cloud-metadata range.

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255))
    return false;
  const [a, b] = parts;
  // 127.0.0.0/8, 10.0.0.0/8, 192.168.0.0/16, 169.254.0.0/16
  if (a === 127 || a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12 (172.16–172.31)
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 100.64.0.0/10 (100.64–100.127, CGNAT / shared address space)
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (lower === "::1") return true;
  // fc00::/7 (unique local: fc00–fdff)
  if (/^f[cd][0-9a-f]{2}:/i.test(lower)) return true;
  // fe80::/10 (link-local)
  if (/^fe[89ab][0-9a-f]:/i.test(lower)) return true;
  return false;
}

// S63 (2026-05-21): assertNotPrivate now returns the resolved IP list so the
// caller can PIN that IP through the dispatcher, eliminating the TOCTOU window
// between validate-time DNS and fetch-time DNS (textbook rebinding).
export async function assertNotPrivate(hostname: string): Promise<string[]> {
  const { promises: dns } = await import("node:dns");
  let addrs: string[];
  try {
    const result = await dns.lookup(hostname, { all: true, verbatim: true });
    addrs = result.map((r) => r.address);
  } catch {
    throw new Error(`blocked private IP: could not resolve ${hostname}`);
  }
  for (const addr of addrs) {
    if (isPrivateIpv4(addr) || isPrivateIpv6(addr)) {
      throw new Error(`blocked private IP: ${hostname} resolves to ${addr}`);
    }
  }
  return addrs;
}

export interface ValidatedUrl {
  url: URL;
  // null = "use globalThis.fetch with no pin" — reserved for the localhost
  // allow-path (already a literal address; no rebinding surface). Lets the
  // existing fetch-bounded.test.ts vi.spyOn(globalThis, "fetch") keep working.
  validatedIp: string | null;
}

export async function validateUrl(raw: string): Promise<ValidatedUrl> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`Invalid URL: ${raw}`);
  }
  const allowPrivate = process.env.TAPROOT_ALLOW_PRIVATE_NETWORKS === "1";
  if (u.protocol === "https:") {
    if (!allowPrivate) {
      const addrs = await assertNotPrivate(u.hostname);
      return { url: u, validatedIp: addrs[0] };
    }
    // allowPrivate https: — best-effort pin so private targets still work
    // when DNS resolution succeeds. Tolerate failure (returns null = no pin).
    try {
      const addrs = await assertNotPrivate(u.hostname);
      return { url: u, validatedIp: addrs[0] };
    } catch {
      return { url: u, validatedIp: null };
    }
  }
  if (u.protocol === "http:") {
    const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
    if (allowPrivate || localHosts.has(u.hostname)) {
      return { url: u, validatedIp: null };
    }
  }
  throw new Error(`blocked private IP: only https: URLs are permitted`);
}

// S63: pin the TCP connect to the IP we already validated. Hostname stays in
// the URL so TLS SNI + virtual hosting still work; only the underlying socket
// uses the pinned IP. One Agent per fetch — close eagerly to avoid socket
// leaks under sustained load.
async function fetchWithPinnedIp(
  url: URL,
  validatedIp: string,
  init: RequestInit,
): Promise<Response> {
  const family = validatedIp.includes(":") ? 6 : 4;
  const agent = new Agent({
    connect: {
      lookup: (
        _hostname: string,
        _opts: unknown,
        cb: (err: Error | null, address: string, family: number) => void,
      ) => cb(null, validatedIp, family),
    },
  });
  try {
    return (await undiciFetch(url, {
      ...init,
      dispatcher: agent,
    } as Parameters<typeof undiciFetch>[1])) as unknown as Response;
  } finally {
    void agent.close().catch(() => {});
  }
}

// 10 MB default — p99 markdown article ~200 KB, 50× headroom.
// Override at runtime with TAPROOT_FETCH_MAX_BYTES env-var (no redeploy needed).
// Evaluated at call time so Railway env-var changes take effect without restart.
function getMaxFetchBodyBytes(): number {
  const env = Number(process.env.TAPROOT_FETCH_MAX_BYTES);
  return Number.isFinite(env) && env > 0 ? env : 10 * 1024 * 1024;
}

async function readBoundedText(
  response: Response,
  maxBytes: number,
): Promise<string> {
  if (!response.body) {
    // No body stream (e.g. some test mocks) — fall back to .text() with a
    // byte-count check. Fail-closed: missing Content-Length is not a bypass.
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new Error(`Response body exceeded ${maxBytes} bytes`);
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`Response body exceeded ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* idempotent */
    }
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}

/**
 * Fetch a URL, convert HTML to plain text, and extract a title from <title>
 * or first H1. Throws on HTTP errors so callers can format their own messages.
 * SSRF-safe: validates the URL and each redirect hop against a private-IP
 * blocklist before fetching (H4 05-01 / H2 04-30).
 */
export async function fetchUrlAsText(rawUrl: string): Promise<FetchedUrl> {
  let { url: current, validatedIp } = await validateUrl(rawUrl);

  const MAX_REDIRECTS = 5;
  let response: Response | undefined;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const init: RequestInit = {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,text/plain,*/*",
      },
      signal: AbortSignal.timeout(15000),
      redirect: "manual",
    };

    response = validatedIp
      ? await fetchWithPinnedIp(current, validatedIp, init)
      : await fetch(current.toString(), init);

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("Redirect with no Location header");
      if (hop === MAX_REDIRECTS) throw new Error("Too many redirects");
      // S63: re-validate AND re-pin per hop. Without re-pin, an attacker can
      // redirect to a hostile-DNS hostname and bypass the original pin —
      // hop-N IP validated, hop-N+1 connect goes wherever undici resolves.
      ({ url: current, validatedIp } = await validateUrl(
        new URL(location, current).toString(),
      ));
      continue;
    }
    break;
  }

  if (!response!.ok) {
    throw new Error(`HTTP ${response!.status} ${response!.statusText}`);
  }

  const contentType = response!.headers.get("content-type") || "";
  const rawBody = await readBoundedText(response!, getMaxFetchBodyBytes());

  let title: string | null = null;
  if (
    contentType.includes("text/html") ||
    contentType.includes("application/xhtml")
  ) {
    const titleMatch = rawBody.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (titleMatch) {
      title = titleMatch[1].trim().replace(/\s+/g, " ");
    }
    return { body: htmlToText(rawBody), title };
  }
  return { body: rawBody, title: null };
}
