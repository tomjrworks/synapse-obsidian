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

/**
 * Fetch a URL, convert HTML to plain text, and extract a title from <title>
 * or first H1. Throws on HTTP errors so callers can format their own messages.
 */
export async function fetchUrlAsText(url: string): Promise<FetchedUrl> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml,text/plain,*/*",
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get("content-type") || "";
  const rawBody = await response.text();

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
