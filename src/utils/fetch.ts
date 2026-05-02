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

async function assertNotPrivate(hostname: string): Promise<void> {
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
}

async function validateUrl(raw: string): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`Invalid URL: ${raw}`);
  }
  const allowPrivate = process.env.TAPROOT_ALLOW_PRIVATE_NETWORKS === "1";
  if (u.protocol === "https:") {
    if (!allowPrivate) await assertNotPrivate(u.hostname);
    return u;
  }
  if (u.protocol === "http:") {
    const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
    if (allowPrivate || localHosts.has(u.hostname)) return u;
  }
  throw new Error(`blocked private IP: only https: URLs are permitted`);
}

/**
 * Fetch a URL, convert HTML to plain text, and extract a title from <title>
 * or first H1. Throws on HTTP errors so callers can format their own messages.
 * SSRF-safe: validates the URL and each redirect hop against a private-IP
 * blocklist before fetching (H4 05-01 / H2 04-30).
 */
export async function fetchUrlAsText(rawUrl: string): Promise<FetchedUrl> {
  let current = await validateUrl(rawUrl);

  const MAX_REDIRECTS = 5;
  let response: Response | undefined;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    response = await fetch(current.toString(), {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,text/plain,*/*",
      },
      signal: AbortSignal.timeout(15000),
      redirect: "manual",
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("Redirect with no Location header");
      if (hop === MAX_REDIRECTS) throw new Error("Too many redirects");
      // Resolve relative redirects against current URL, then re-validate.
      current = await validateUrl(new URL(location, current).toString());
      continue;
    }
    break;
  }

  if (!response!.ok) {
    throw new Error(`HTTP ${response!.status} ${response!.statusText}`);
  }

  const contentType = response!.headers.get("content-type") || "";
  const rawBody = await response!.text();

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
