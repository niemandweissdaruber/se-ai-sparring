// ---------------------------------------------------------------------------
// SE Ranking MCP proxy — Anthropic's path to SE Ranking
//
// WHY THIS EXISTS
// SE Ranking's MCP server rejects `Authorization: Bearer <api key>` on the MCP
// `initialize` handshake (401, pointing at an OAuth flow it wants instead). The
// same key authenticates the whole session when presented as `X-Api-Key`.
//
// OpenAI's MCP tool can carry arbitrary headers, so it sends `X-Api-Key` and
// talks to SE Ranking directly — it does NOT come through here. Anthropic's
// connector can only send `authorization_token` (always as a Bearer) and
// rejects a custom `headers` field outright, so Claude has no way to present
// the key in the one form the server accepts.
//
// This function closes exactly that gap: it is a transparent MCP passthrough
// whose only transformation is swapping our own Bearer secret for SE Ranking's
// `X-Api-Key`.
//
// NOT AN OPEN PROXY
//   * The upstream is the FIXED constant below. There is no caller-supplied
//     target, no path passthrough, no query-driven destination.
//   * Every request must present `Authorization: Bearer <MCP_PROXY_SECRET>`.
//   * Neither secret is ever written to a response body or a log line.
//
// Cloudflare Access must BYPASS /api/mcp/* — Anthropic calls this from its own
// cloud and cannot complete an interactive login. The bearer secret, the
// dedicated read-only SE Ranking key, and the five-tool allowlist in
// chat.js are what protect it. See the README.
// ---------------------------------------------------------------------------

// The one and only destination. Never derived from the request.
const UPSTREAM_URL = "https://api.seranking.com/mcp";

// Headers that describe a specific hop's encoding/framing. Passing them
// through would misrepresent the body we actually forward, so they are dropped
// in both directions.
const HOP_BY_HOP = [
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "upgrade",
];

// Cloudflare's own request metadata. Harmless upstream, but there is no reason
// to leak our infrastructure details to a third party.
const DROP_FROM_FORWARD = [
  "authorization",          // ESSENTIAL: a Bearer makes SE Ranking 401 on initialize
  "host",
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "cf-worker",
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-real-ip",
  "cf-access-jwt-assertion", // Access's own token, meaningless to SE Ranking
];

// One handler for every method. MCP uses POST for JSON-RPC, GET to open the
// SSE channel, and DELETE to end a session — all of which are forwarded as-is.
export async function onRequest(context) {
  const { request, env } = context;

  // --- 1. Authenticate the caller ------------------------------------
  const expected = env.MCP_PROXY_SECRET;
  if (!expected) {
    // Misconfiguration, not a caller error. Say nothing about which secret.
    console.error("[mcp-proxy] MCP_PROXY_SECRET is not configured");
    return problem(503, "proxy_unconfigured", "This proxy is not configured.");
  }

  const presented = bearerToken(request.headers.get("Authorization"));
  if (!presented || !constantTimeEqual(presented, expected)) {
    // Deliberately terse: no hint about length, format, or which part failed.
    return problem(401, "unauthorized", "A valid bearer token is required.");
  }

  const upstreamKey = env.SERANKING_API_KEY;
  if (!upstreamKey) {
    console.error("[mcp-proxy] SERANKING_API_KEY is not configured");
    return problem(503, "upstream_unconfigured", "This proxy is not configured.");
  }

  // --- 2. Build the forwarded request --------------------------------
  // Start from the caller's headers so MCP session state (Mcp-Session-Id,
  // Mcp-Protocol-Version), Accept and Content-Type all survive the hop.
  const forwardHeaders = new Headers(request.headers);
  DROP_FROM_FORWARD.forEach((h) => forwardHeaders.delete(h));
  HOP_BY_HOP.forEach((h) => forwardHeaders.delete(h));

  // The single transformation this whole function exists to perform.
  forwardHeaders.set("X-Api-Key", upstreamKey);

  const init = {
    method: request.method,
    headers: forwardHeaders,
    redirect: "manual",     // never chase a redirect to somewhere unintended
  };

  // GET/HEAD carry no body. Other methods do: MCP request bodies are small
  // JSON-RPC messages, so buffering avoids any half-duplex streaming caveats
  // while response streaming (the part that matters for SSE) stays intact.
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = await request.arrayBuffer();
  }

  // --- 3. Forward, and hand the response straight back ---------------
  let upstream;
  try {
    upstream = await fetch(UPSTREAM_URL, init);
  } catch (err) {
    // Log the failure mode, never the headers (they hold the key).
    console.error("[mcp-proxy] upstream fetch failed:", err && err.message);
    return problem(502, "upstream_unreachable", "Could not reach the data service.");
  }

  const responseHeaders = new Headers(upstream.headers);
  HOP_BY_HOP.forEach((h) => responseHeaders.delete(h));

  // Returning upstream.body unread keeps `text/event-stream` flowing
  // unbuffered, which is what the MCP SSE channel needs. Status, status text
  // and the remaining headers — including Mcp-Session-Id on the way back —
  // pass through untouched.
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

// --- Helpers ---------------------------------------------------------

// Pull the token out of an `Authorization: Bearer <token>` header.
function bearerToken(value) {
  if (typeof value !== "string") return null;
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match ? match[1].trim() : null;
}

// Compare without leaking where two secrets diverge. Uses the runtime's
// timing-safe primitive when present, with an equivalent fallback.
// (Length inequality short-circuits — a length oracle on a random secret is
// not a meaningful weakness, and the alternative leaks more.)
function constantTimeEqual(a, b) {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;

  if (crypto && crypto.subtle && typeof crypto.subtle.timingSafeEqual === "function") {
    return crypto.subtle.timingSafeEqual(ab, bb);
  }

  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

// Small error response. Never names a secret or echoes caller input.
function problem(status, code, message) {
  return new Response(JSON.stringify({ error: code, message }), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}
