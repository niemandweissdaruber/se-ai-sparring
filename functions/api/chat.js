// ---------------------------------------------------------------------------
// AI vs AI — Pages Function
// Single POST endpoint: /api/chat
//
// BRING YOUR OWN KEY.
//
// This Worker holds NO API keys. It never reads them from the environment —
// there is deliberately no env fallback, so a deployed copy can never spend
// the operator's credit. Each request carries the caller's own key in the
// `x-provider-key` header; it is used for that one upstream call and then
// goes out of scope. Nothing is stored, cached, or logged.
//
// Key hygiene rules for anyone editing this file:
//   * never put `key` (or a whole request/headers object) into console.*
//   * every logged provider payload goes through redact() first
//   * never echo a key back in a response body
//
// No SDK packages — Cloudflare Workers don't run full Node.js, so we call the
// providers' plain REST endpoints with fetch().
// ---------------------------------------------------------------------------

// --- CONFIG ---------------------------------------------------------------
// Both model IDs live here so they're trivial to swap.
//
// Anthropic: Claude Opus 5 via the Messages API.
// OpenAI:    GPT-5.6 Sol via the RESPONSES API (not chat/completions — the
//            current model family is served through /v1/responses).
//
// The token caps are the ONLY place output length is limited. Raising them
// makes truncation rarer but never impossible, which is why every provider
// call below also reports whether the reply was actually cut off.
const CONFIG = {
  anthropic: {
    model: "claude-opus-5",
    apiUrl: "https://api.anthropic.com/v1/messages",
    version: "2023-06-01",
    maxTokens: 8000,
  },
  openai: {
    model: "gpt-5.6-sol",
    apiUrl: "https://api.openai.com/v1/responses",
    maxOutputTokens: 8000,
    // Reasoning effort: none | low | medium | high | xhigh | max
    reasoningEffort: "medium",
  },
};

// --- SYSTEM PROMPTS -------------------------------------------------------
// These three prompts are the heart of the app. Keep the wording — it matters.
const SYSTEM_PROMPTS = {
  chat: "", // default: no special instructions, just a normal helpful assistant

  critique:
    "You are reviewing another AI assistant's answer. Be specific and useful, " +
    "not polite. Focus on: (1) factual errors or claims stated with more " +
    "confidence than the evidence supports; (2) important omissions or missing " +
    "caveats; (3) reasoning gaps. If a claim is verifiable and correct, say so " +
    "briefly rather than manufacturing disagreement — do not invent problems to " +
    "seem thorough. If you lack the information to judge something, say that " +
    "explicitly. Start with a one-line verdict (agree / partly agree / disagree), " +
    "then bullet your specific points. Be concise.",

  rebuttal:
    "Another AI assistant reviewed your previous answer. Respond honestly: " +
    "concede any point where it is right and correct yourself clearly, and push " +
    "back where you think it is wrong or has misread you — explaining why. Do not " +
    "cave just to be agreeable, and do not defend a mistake. End with a corrected " +
    "version of your answer if anything changed.",
};

// ---------------------------------------------------------------------------
// Route handler — Cloudflare Pages Functions call onRequestPost for POST.
// ---------------------------------------------------------------------------
export async function onRequestPost(context) {
  // No `env` here on purpose: this Worker has no keys of its own.
  const { request } = context;

  // Parse the request body defensively.
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "bad_request", message: "Invalid JSON body." }, 400);
  }

  const { provider, mode, messages, question, targetText, stream, useMcp } =
    body || {};

  // Validate provider.
  if (provider !== "anthropic" && provider !== "openai") {
    return json({ error: "bad_request", message: "Unknown provider." }, 400);
  }

  // Validate mode.
  if (!["chat", "critique", "rebuttal"].includes(mode)) {
    return json({ error: "bad_request", message: "Unknown mode." }, 400);
  }

  // The caller's own key, one request at a time. Read it, use it, drop it.
  // There is NO environment-variable fallback — see the note at the top of
  // this file. If the header is absent the client is told which provider
  // needs connecting, and it prompts for the key.
  const apiKey = (request.headers.get("x-provider-key") || "").trim();
  if (!apiKey) {
    return json({ error: "missing_key", provider }, 200);
  }

  // Build the message list we'll send to the model, depending on the mode.
  const builtMessages = buildMessages({ mode, messages, question, targetText });
  const system = SYSTEM_PROMPTS[mode];

  // Optional SE Ranking grounding. `mcp.enabled` is false unless the client
  // asked for it AND the deployment is configured for it — when false, not a
  // single MCP field is added below, so the request is identical to one from
  // before this feature existed.
  const mcp = resolveMcp({ useMcp, env: context.env, request, provider });
  if (mcp.error) {
    // Misconfiguration or an unauthenticated caller: say so plainly instead
    // of quietly answering without the data that was asked for.
    return json({ error: "mcp_unavailable", provider, message: mcp.error }, 200);
  }

  // Streaming path. Only an explicit `stream: true` opts in — everything
  // else keeps the original blocking behaviour, which is what the client
  // falls back to if a stream can't be established.
  //
  // Note this sits AFTER the missing-key check on purpose: a missing key
  // still answers with ordinary JSON, so the client can show its banner
  // without having to interpret an event stream.
  if (stream === true) {
    return handleStreamRequest(context, {
      provider,
      apiKey,
      system,
      messages: builtMessages,
      mcp,
    });
  }

  try {
    // Both callers return { text, truncated }. `truncated` means the model hit
    // the output cap mid-reply — the text is still good, just incomplete, so
    // we return it with the flag instead of throwing. The client shows a
    // notice and offers a "Continue" button.
    let result;
    if (provider === "anthropic") {
      result = await callAnthropic({ apiKey, system, messages: builtMessages, mcp });
    } else {
      result = await callOpenAI({ apiKey, system, messages: builtMessages, mcp });
    }
    // `usage` is the normalized token count (or null when the provider didn't
    // give us a usable one) and `model` is the exact model ID that served the
    // request, so the client can price it without duplicating CONFIG.
    return json(
      {
        text: result.text,
        truncated: result.truncated,
        usage: result.usage,
        model: CONFIG[provider].model,
      },
      200
    );
  } catch (err) {
    // Never leak raw API error bodies or the key to the CLIENT. We do log the
    // detail server-side (visible in `wrangler pages dev` / Cloudflare logs)
    // because that's where you actually debug model-name and parameter errors.
    // Log enough to debug a model-name or parameter problem, never enough
    // to leak a key: err.detail is the provider's own response body, and it
    // goes through redact() on the way out.
    console.error(
      "Provider call failed:",
      provider,
      err && err.message,
      "\ndetail:",
      redact((err && err.detail) || "(none)")
    );
    return json(
      {
        error: "provider_error",
        provider,
        message: friendlyError(err),
      },
      200
    );
  }
}

// ---------------------------------------------------------------------------
// Message construction
//
// - chat:     pass the full conversation history straight through.
// - critique: the "messages" we receive is a single-item array carrying the
//             text to critique; we wrap it with the original question as context.
// - rebuttal: pass the conversation history, then append the critique as a new
//             user turn framed by the rebuttal system prompt.
// ---------------------------------------------------------------------------
function buildMessages({ mode, messages, question, targetText }) {
  if (mode === "critique") {
    // targetText is what we're critiquing (a whole reply or a selected excerpt).
    // question is the user's original prompt, included so the critic has context.
    const ctx = question
      ? `The user originally asked:\n"""${question}"""\n\n`
      : "";
    const target = targetText || "";
    return [
      {
        role: "user",
        content:
          ctx +
          `Here is the other assistant's answer to review:\n"""${target}"""`,
      },
    ];
  }

  // chat and rebuttal both send the running conversation history as-is.
  // For rebuttal, the caller has already appended a user turn containing the
  // critique text; the rebuttal system prompt does the framing.
  return Array.isArray(messages) ? messages : [];
}

// ---------------------------------------------------------------------------
// Anthropic REST call — POST /v1/messages
// ---------------------------------------------------------------------------
async function callAnthropic({ apiKey, system, messages, mcp }) {
  const payload = {
    model: CONFIG.anthropic.model,
    max_tokens: CONFIG.anthropic.maxTokens,
    messages, // [{ role: "user" | "assistant", content: "..." }]
  };
  // Anthropic takes the system prompt as a top-level field, not a message.
  if (system) payload.system = system;

  const headers = {
    "content-type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": CONFIG.anthropic.version,
  };

  // Server + toolset go in together or not at all (the API requires every
  // mcp_servers entry to be referenced by exactly one mcp_toolset).
  // Claude is pointed at our proxy — see ANTHROPIC_MCP_SUPPORTED.
  if (mcp && mcp.enabled && ANTHROPIC_MCP_SUPPORTED && mcp.proxyUrl) {
    Object.assign(
      payload,
      anthropicMcpFields({ url: mcp.proxyUrl, token: mcp.proxySecret })
    );
    headers["anthropic-beta"] = ANTHROPIC_MCP_BETA;
  }

  const res = await fetch(CONFIG.anthropic.apiUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    throw await providerError(res);
  }

  const data = await res.json();
  // Response shape: { content: [{ type: "text", text: "..." }, ...],
  //                   stop_reason: "end_turn" | "max_tokens" | ... }
  const text = (data.content || [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();

  // "max_tokens" is Anthropic's signal that the reply was cut off by the cap.
  const truncated = data.stop_reason === "max_tokens";

  return {
    text: text || "(empty response)",
    truncated,
    usage: normalizeUsage("anthropic", data.usage),
  };
}

// ---------------------------------------------------------------------------
// OpenAI REST call — POST /v1/responses  (Responses API)
//
// Differences from the older chat/completions shape:
//   - system prompt goes in `instructions`, not as a message
//   - the conversation goes in `input` (same role/content objects)
//   - the token cap is `max_output_tokens`, not `max_tokens`
//   - reasoning effort is set via `reasoning: { effort }`
// ---------------------------------------------------------------------------
async function callOpenAI({ apiKey, system, messages, mcp }) {
  const payload = {
    model: CONFIG.openai.model,
    input: messages, // [{ role: "user" | "assistant", content: "..." }]
    max_output_tokens: CONFIG.openai.maxOutputTokens,
  };
  if (system) payload.instructions = system;
  if (CONFIG.openai.reasoningEffort) {
    payload.reasoning = { effort: CONFIG.openai.reasoningEffort };
  }
  // MCP is just another tool entry for the Responses API.
  if (mcp && mcp.enabled) payload.tools = [openAiMcpTool(mcp.key)];

  const res = await fetch(CONFIG.openai.apiUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    throw await providerError(res);
  }

  const data = await res.json();

  // The Responses API reports a cut-off reply as status "incomplete" with
  // incomplete_details.reason === "max_output_tokens". Be tolerant about the
  // shape: treat a bare "incomplete" status as truncated too, since the only
  // length-related reason we cap for here is the output limit.
  const reason = data.incomplete_details && data.incomplete_details.reason;
  const truncated =
    data.status === "incomplete" &&
    (reason === "max_output_tokens" || reason === undefined || reason === null);

  return {
    text: extractOpenAIText(data) || "(empty response)",
    truncated,
    usage: normalizeUsage("openai", data.usage),
  };
}

// The Responses API may return a convenience `output_text`, or an `output`
// array containing reasoning blocks alongside the message. Handle both, and
// skip non-message blocks so reasoning output never leaks into the chat.
function extractOpenAIText(data) {
  if (typeof data.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }

  const blocks = Array.isArray(data.output) ? data.output : [];
  const parts = [];
  for (const block of blocks) {
    if (block.type !== "message") continue;
    const content = Array.isArray(block.content) ? block.content : [];
    for (const piece of content) {
      if (piece.type === "output_text" && typeof piece.text === "string") {
        parts.push(piece.text);
      }
    }
  }
  return parts.join("").trim();
}

// ---------------------------------------------------------------------------
// SE RANKING MCP (optional grounding)
//
// When the client sends `useMcp: true`, both providers are pointed at SE
// Ranking's MCP server DIRECTLY — there is no proxy here. This Worker only
// supplies the credential, which is why that credential must never leave it.
//
// SECURITY CONTRACT — do not weaken any of these:
//   1. SERANKING_API_KEY is read from the Cloudflare environment and used ONLY
//      inside the provider request bodies below. It is never echoed to the
//      client, never logged (redact() covers the log paths), and never part of
//      any response this function returns.
//   2. Use a RESTRICTED, READ-ONLY SE Ranking key. See README.
//   3. Read-only again at the tool layer: only the whitelist below is exposed.
//      The server publishes 217 tools, 84 of which mutate account data
//      (create/add/update/delete/move/share/import/recheck/run/set). None of
//      them is reachable, for either provider.
//   4. The deployment sits behind Cloudflare Access. ENFORCE_ACCESS_JWT below
//      is the defence-in-depth check for that.
// ---------------------------------------------------------------------------

const SERANKING_MCP_URL = "https://api.seranking.com/mcp";
const SERANKING_SERVER_LABEL = "se_ranking";

// The ONLY tools either model can call. Names were taken verbatim from a live
// `tools/list` against the server above — none are guessed. All are `get*`
// research tools in the DATA_ namespace; none touches project/account data.
//
// Removing a tool is a one-line edit; adding one is not — confirm the exact
// name against `tools/list` first, and confirm it only reads.
const SERANKING_TOOLS = [
  "DATA_getDomainOverviewByCountry", // domain overview, per country/database
  "DATA_getDomainKeywords",          // organic keywords a domain ranks for
  "DATA_getKeywordsMetrics",         // keyword research: volume, KD, CPC, intent
  "DATA_getBacklinksSummary",        // backlink profile summary
  "DATA_getAiSearchOverview",        // AI search visibility
];

// DELIBERATELY ABSENT: DATA_getSerpResults. It queues a SERP task server-side,
// consumes SERP credits, and polls for up to five minutes — long enough to
// stall a generation turn. Every tool above returns immediately from stored
// data. Re-add it only if you accept that cost and latency.

// Human-friendly labels for the tool chips the client renders. Falls back to
// the raw name, so a tool added later still shows something sensible.
const SERANKING_TOOL_LABELS = {
  DATA_getDomainOverviewByCountry: "domain overview",
  DATA_getDomainKeywords: "organic keywords",
  DATA_getKeywordsMetrics: "keyword metrics",
  DATA_getBacklinksSummary: "backlinks summary",
  DATA_getAiSearchOverview: "AI search visibility",
};

// Defence in depth for the Cloudflare Access requirement. Access terminates in
// front of this Worker and stamps every authenticated request with a JWT
// header; a request without one never went through it. Set to false only for
// local `wrangler pages dev`, where there is no Access in front.
const ENFORCE_ACCESS_JWT = true;

// Decide whether MCP should be attached to this request, and why not if not.
// Returns { enabled, key?, proxyUrl?, proxySecret?, error? } — `error` is a
// client-safe reason.
//
// The two providers need different things, so `provider` matters here:
//   openai    — the SE Ranking key, sent directly as X-Api-Key
//   anthropic — our proxy's URL and secret (the SE Ranking key stays here)
function resolveMcp({ useMcp, env, request, provider }) {
  if (useMcp !== true) return { enabled: false };

  const key = env && env.SERANKING_API_KEY;
  if (!key) {
    // Deliberately explicit: this is an operator misconfiguration, not a user
    // error, and silently answering without data would be worse.
    return {
      enabled: false,
      error:
        "SE Ranking data is switched on, but this deployment has no " +
        "SERANKING_API_KEY configured. Turn the toggle off, or ask an admin " +
        "to add the key.",
    };
  }

  // Cloudflare Access puts this header on every request it lets through.
  // localhost has no Access in front of it, so it is exempt.
  if (ENFORCE_ACCESS_JWT && !isLocalRequest(request)) {
    const jwt = request.headers.get("Cf-Access-Jwt-Assertion");
    if (!jwt) {
      return {
        enabled: false,
        error:
          "SE Ranking data is only available to signed-in SE Ranking staff. " +
          "This request didn't come through Cloudflare Access.",
      };
    }
  }

  // Anthropic can only reach SE Ranking through our proxy, which needs both a
  // shared secret and a publicly reachable URL.
  if (provider === "anthropic") {
    const proxySecret = env && env.MCP_PROXY_SECRET;
    if (!proxySecret) {
      return {
        enabled: false,
        error:
          "SE Ranking data for Claude needs MCP_PROXY_SECRET configured on this " +
          "deployment. ChatGPT turns are unaffected — switch the primary model, " +
          "or ask an admin to add the secret.",
      };
    }

    const proxyUrl = proxyUrlFor(env, request);
    if (!proxyUrl) {
      return {
        enabled: false,
        error: "Couldn't work out this deployment's proxy URL for SE Ranking data.",
      };
    }

    // Anthropic calls the proxy from its own cloud, so a localhost URL can
    // never work. Fail with an explanation rather than a confusing timeout.
    if (isLocalUrl(proxyUrl)) {
      return {
        enabled: false,
        error:
          "Claude can't reach SE Ranking from a local dev server — Anthropic " +
          "calls our proxy from its own cloud, which can't see localhost. Use a " +
          "deployed URL, or switch the primary model to ChatGPT (which grounds " +
          "anywhere).",
      };
    }

    return { enabled: true, key, proxyUrl, proxySecret };
  }

  return { enabled: true, key };
}

// True for a URL Anthropic's cloud could never dial back to.
function isLocalUrl(value) {
  try {
    const host = new URL(value).hostname;
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "[::1]" ||
      host === "::1" ||
      host.endsWith(".local")
    );
  } catch {
    return false;
  }
}

function isLocalRequest(request) {
  try {
    const host = new URL(request.url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  } catch {
    return false;
  }
}

// --- Provider-specific request fragments -----------------------------------
// Each returns the object to merge into that provider's payload. Both are
// called ONLY when mcp.enabled is true, so a disabled toggle produces a
// byte-for-byte unchanged request.

// OpenAI /v1/responses: MCP is a tool entry.
//
// AUTH: SE Ranking's MCP server does NOT accept a static API key as a bearer
// token — `Authorization: Bearer <key>` fails the MCP `initialize` handshake
// with 401 and a pointer to its OAuth flow. The same key DOES authenticate the
// whole session when sent as `X-Api-Key`, so that is what we send. OpenAI's
// MCP tool supports arbitrary `headers`, which makes this possible.
// (Verified against the live server: initialize/tools/list/tools/call all 200.)
function openAiMcpTool(key) {
  return {
    type: "mcp",
    server_label: SERANKING_SERVER_LABEL,
    server_url: SERANKING_MCP_URL,
    headers: { "X-Api-Key": key },
    require_approval: "never",
    allowed_tools: SERANKING_TOOLS,
  };
}

// Anthropic reaches SE Ranking through our own proxy, not directly.
//
// The constraint that forces this:
//   * Anthropic's `mcp_servers` entry only offers `authorization_token`, which
//     it sends as `Authorization: Bearer <token>`. A `headers` field is
//     rejected outright ("mcp_servers.0.headers: Extra inputs are not
//     permitted").
//   * SE Ranking's MCP server rejects a static API key presented as a bearer
//     token during `initialize` (401, pointing at an OAuth flow). It accepts
//     that key only via `X-Api-Key`.
//   * Its OAuth server advertises grant_types ["authorization_code",
//     "refresh_token"] — no client_credentials — so a token cannot be minted
//     non-interactively either.
//
// So Claude is pointed at functions/api/mcp/seranking.js, which authenticates
// us with MCP_PROXY_SECRET and swaps that Bearer for the X-Api-Key the server
// wants. OpenAI is unaffected and still calls SE Ranking directly.
//
// NOTE: Anthropic connects from its own cloud, so the proxy URL must be
// publicly reachable. Claude grounding therefore only works on a DEPLOYED
// URL — never against localhost. OpenAI grounding works anywhere.
const ANTHROPIC_MCP_SUPPORTED = true;

// Where Anthropic should send its MCP traffic. An explicit env var wins;
// falling back to this request's own origin keeps preview deployments working
// with no extra configuration.
function proxyUrlFor(env, request) {
  const configured = env && env.MCP_PROXY_URL;
  if (typeof configured === "string" && configured.trim()) return configured.trim();
  try {
    return new URL(request.url).origin + "/api/mcp/seranking";
  } catch {
    return null;
  }
}

// Anthropic /v1/messages: an mcp_servers entry PLUS a matching mcp_toolset.
// The API requires that every server in mcp_servers is referenced by exactly
// one toolset, so these two always travel together — or not at all.
//
// default_config.enabled = false is the important half: it denies everything
// the server offers, and `configs` then re-enables only the whitelist. A tool
// that isn't listed cannot be called even if the server advertises it.
// The url is OUR proxy and the token is OUR proxy secret — the SE Ranking key
// itself never leaves the Worker on this path.
function anthropicMcpFields({ url, token }) {
  const configs = {};
  SERANKING_TOOLS.forEach((name) => {
    configs[name] = { enabled: true };
  });

  return {
    mcp_servers: [
      {
        type: "url",
        url,
        name: SERANKING_SERVER_LABEL,
        authorization_token: token,
      },
    ],
    tools: [
      {
        type: "mcp_toolset",
        mcp_server_name: SERANKING_SERVER_LABEL,
        default_config: { enabled: false },  // deny by default
        configs,                             // ...then allow only these
      },
    ],
  };
}

// The beta header Anthropic requires for MCP connector requests.
const ANTHROPIC_MCP_BETA = "mcp-client-2025-11-20";

// Label used on the tool chip the client renders.
function toolLabel(name) {
  return SERANKING_TOOL_LABELS[name] || name || "tool";
}

// ---------------------------------------------------------------------------
// TOKEN USAGE
//
// Normalized shape handed to the client:
//   { inputTokens, outputTokens, cachedTokens, cacheWriteTokens }
//
// CONVENTION — read this before changing anything here:
//   `inputTokens` is always the number of tokens billed at the BASE input
//   rate. Cached tokens are reported SEPARATELY and are never included in it.
//   The providers disagree natively, so they are reconciled here:
//     * Anthropic already excludes cache reads/writes from input_tokens.
//     * OpenAI includes cached tokens inside input_tokens, so we subtract.
//   That way the client has one rule and can price each bucket directly.
//
// Reasoning/thinking tokens are billed at the output rate by both providers
// and are already inside output_tokens — nothing extra to do, but it explains
// why output counts can look high.
//
// Returns null when nothing usable came back. The client then omits the cost
// line for that message rather than showing a number we can't stand behind.
// ---------------------------------------------------------------------------
function normalizeUsage(provider, raw) {
  if (!raw || typeof raw !== "object") return null;

  // Anything non-numeric, negative or NaN counts as zero rather than throwing.
  const num = (v) =>
    typeof v === "number" && isFinite(v) && v > 0 ? Math.round(v) : 0;

  let usage;
  if (provider === "anthropic") {
    usage = {
      inputTokens: num(raw.input_tokens),
      outputTokens: num(raw.output_tokens),
      cachedTokens: num(raw.cache_read_input_tokens),
      cacheWriteTokens: num(raw.cache_creation_input_tokens),
    };
  } else {
    const details =
      raw.input_tokens_details && typeof raw.input_tokens_details === "object"
        ? raw.input_tokens_details
        : {};
    const cached = num(details.cached_tokens);
    usage = {
      // Subtract the cached portion so it isn't billed twice by the client.
      inputTokens: Math.max(0, num(raw.input_tokens) - cached),
      outputTokens: num(raw.output_tokens),
      cachedTokens: cached,
      cacheWriteTokens: 0,          // the Responses API doesn't report writes
    };
  }

  // A usage object arrived but nothing numeric came out of it: the shape isn't
  // what we expect. Log a redacted sample so it can be inspected, and report
  // no usage rather than a misleading zero-cost line.
  const total =
    usage.inputTokens + usage.outputTokens +
    usage.cachedTokens + usage.cacheWriteTokens;
  if (total === 0) {
    console.log(`[${provider} usage] unrecognised usage shape — ${snippet(raw)}`);
    return null;
  }

  return usage;
}

// Streamed usage arrives in pieces across terminal events (Anthropic sends
// input counts early and output counts late), so raw fragments are merged as
// they show up and normalized once at the end.
function mergeRawUsage(target, incoming) {
  if (!incoming || typeof incoming !== "object") return target;
  return Object.assign(target || {}, incoming);
}

// ---------------------------------------------------------------------------
// STREAMING
//
// Both providers stream Server-Sent Events, but in different shapes. Rather
// than proxying their raw formats to the browser, we NORMALIZE everything
// into one tiny event vocabulary so the frontend only ever handles:
//
//   { type: "delta", text: "..." }      a chunk of reply text
//   { type: "done",  truncated: bool }  finished (truncated = hit the cap)
//   { type: "error", message: "..." }   friendly message only, never raw
//   { type: "usage", partial: true }    EARLY, best-effort usage + model id
//   { type: "tool",  server, name }     an MCP tool call just started
//
// The "tool" event is informational only. Tool ARGUMENTS and tool RESULTS are
// never forwarded: they are provider-internal traffic, often large, and would
// corrupt the assistant text if concatenated into it. Only the fact that a
// named tool fired is surfaced, so the UI can show a chip.
//
// The "usage" event exists because of Stop: an aborted stream never receives
// the terminal event, so the client would otherwise have no model ID and no
// input-token count with which to price the tokens the provider already
// generated and billed. This event is sent as soon as anything is known —
// immediately for the model ID, and on Anthropic's message_start for real
// input counts. `done` remains authoritative when it arrives.
//
// The normalized stream goes out as SSE itself: one `data: {...}` line per
// event. Provider error bodies and API keys never cross this boundary — they
// are logged server-side only.
// ---------------------------------------------------------------------------
async function handleStreamRequest(context, { provider, apiKey, system, messages, mcp }) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  const send = (obj) =>
    writer.write(encoder.encode("data: " + JSON.stringify(obj) + "\n\n"));

  // Pump the provider stream into our normalized one. Deliberately NOT
  // awaited: the Response is returned immediately and the body fills in as
  // text arrives — that is the whole point of streaming.
  const pump = (async () => {
    try {
      if (provider === "anthropic") {
        await streamAnthropic({ apiKey, system, messages, send, mcp });
      } else {
        await streamOpenAI({ apiKey, system, messages, send, mcp });
      }
    } catch (err) {
      // Same rule as the non-streaming path: log everything, return nothing
      // but a friendly sentence. This covers failures *after* the first byte,
      // which is why the error travels through the stream rather than as an
      // HTTP status.
      console.error(
        "Streaming call failed:",
        provider,
        err && err.message,
        "\ndetail:",
        redact((err && err.detail) || "(none)")
      );
      try {
        await send({ type: "error", message: friendlyError(err) });
      } catch {
        /* the client hung up — nothing to do */
      }
    } finally {
      try {
        await writer.close();
      } catch {
        /* already closed */
      }
    }
  })();

  // Keep the worker alive until the pump finishes, when the runtime offers it.
  if (context && typeof context.waitUntil === "function") context.waitUntil(pump);

  return new Response(readable, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      // Belt and braces against an intermediary buffering the stream.
      "x-accel-buffering": "no",
    },
  });
}

// ---------------------------------------------------------------------------
// Anthropic streaming — POST /v1/messages with stream: true
//
// Text arrives as content_block_delta events carrying delta.type "text_delta".
// The trailing message_delta event carries stop_reason, which is where
// truncation detection lives (same "max_tokens" value as the non-streaming
// response).
// ---------------------------------------------------------------------------
async function streamAnthropic({ apiKey, system, messages, send, mcp }) {
  const payload = {
    model: CONFIG.anthropic.model,
    max_tokens: CONFIG.anthropic.maxTokens,
    messages,
    stream: true,
  };
  if (system) payload.system = system;

  const headers = {
    "content-type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": CONFIG.anthropic.version,
  };

  // Server + toolset together, or neither. See anthropicMcpFields() and
  // ANTHROPIC_MCP_SUPPORTED.
  if (mcp && mcp.enabled && ANTHROPIC_MCP_SUPPORTED && mcp.proxyUrl) {
    Object.assign(
      payload,
      anthropicMcpFields({ url: mcp.proxyUrl, token: mcp.proxySecret })
    );
    headers["anthropic-beta"] = ANTHROPIC_MCP_BETA;
  }

  const res = await fetch(CONFIG.anthropic.apiUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  // A failure before the stream opens is a normal HTTP error.
  if (!res.ok) throw await providerError(res);

  const logUnknown = makeUnknownEventLogger("Anthropic");
  let truncated = false;
  // Usage is split across events: message_start carries the input and cache
  // counts, message_delta / message_stop carry the final output count. Merge
  // whatever turns up and normalize once at the end.
  let rawUsage = null;

  // Which content block indexes are MCP tool traffic rather than reply text.
  // Anthropic interleaves mcp_tool_use / mcp_tool_result blocks with the text
  // blocks in the SAME stream, addressed by `index`. Deltas for those indexes
  // (input_json_delta, and any text inside a result) must never be forwarded
  // as assistant output.
  const toolBlocks = new Set();

  // Tell the client which model is answering before any text arrives, so a
  // Stop can still be priced. See the "usage" event note above.
  await send({ type: "usage", partial: true, usage: null, model: CONFIG.anthropic.model });

  await readSSE(res, async (evt) => {
    const d = evt.data;
    if (!d || typeof d !== "object") return;

    // The event name is in both the SSE `event:` line and the payload's
    // `type` field. Prefer the payload; fall back to the line.
    const type = d.type || evt.event;

    switch (type) {
      case "content_block_delta": {
        // Belongs to an MCP tool block: not assistant text, drop it.
        // (input_json_delta carries the tool's arguments.)
        if (typeof d.index === "number" && toolBlocks.has(d.index)) return;

        const delta = d.delta || {};
        // Only text_delta is forwarded. Any other delta kind (thinking, tool
        // input) must never leak into the chat.
        if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text) {
          await send({ type: "delta", text: delta.text });
        }
        return;
      }

      case "message_start": {
        // Input + cache counts live on the initial message object. Forward
        // them straight away: these are REAL numbers, and if the reader hits
        // Stop they're all the client will ever get.
        if (d.message) rawUsage = mergeRawUsage(rawUsage, d.message.usage);
        const early = normalizeUsage("anthropic", rawUsage);
        if (early) {
          await send({
            type: "usage",
            partial: true,
            usage: early,
            model: CONFIG.anthropic.model,
          });
        }
        return;
      }

      case "message_delta":
        // Where stop_reason lands on a streamed response — and the final
        // output_tokens count.
        if (d.delta && d.delta.stop_reason === "max_tokens") truncated = true;
        rawUsage = mergeRawUsage(rawUsage, d.usage);
        return;

      case "message_stop":
        // Some versions repeat usage here; harmless to merge again.
        rawUsage = mergeRawUsage(rawUsage, d.usage);
        return;

      case "error":
        // Anthropic can report a mid-stream failure as an event.
        console.error("Anthropic stream error event:", snippet(d));
        await send({
          type: "error",
          message: "The model stopped part-way through. Please try again.",
        });
        return;

      case "content_block_start": {
        const block = d.content_block || {};
        // MCP traffic: remember the index so its deltas are skipped, and
        // announce the call so the UI can show a chip. The tool NAME lives on
        // the mcp_tool_use block; arguments stream in afterwards and are
        // deliberately dropped.
        if (block.type === "mcp_tool_use" || block.type === "mcp_tool_result") {
          if (typeof d.index === "number") toolBlocks.add(d.index);
          if (block.type === "mcp_tool_use") {
            await send({
              type: "tool",
              server: block.server_name || SERANKING_SERVER_LABEL,
              name: toolLabel(block.name),
            });
          }
        }
        return;
      }

      case "content_block_stop":
        // The block is finished; stop tracking it either way.
        if (typeof d.index === "number") toolBlocks.delete(d.index);
        return;

      // Known, uninteresting.
      case "ping":
        return;

      default:
        logUnknown(type, d);
    }
  });

  await send({
    type: "done",
    truncated,
    usage: normalizeUsage("anthropic", rawUsage),
    model: CONFIG.anthropic.model,
  });
}

// ---------------------------------------------------------------------------
// OpenAI streaming — POST /v1/responses with stream: true
//
// The Responses API emits a lot of event types and the exact set moves over
// time, so this parser is deliberately loose: it matches on the `type` field,
// forwards only output-text deltas, treats terminal events as advisory, and
// LOGS anything it doesn't recognise (once per type per request) instead of
// throwing. Nothing here assumes a fixed event order — the reply is whatever
// text arrived by the time the body ends.
// ---------------------------------------------------------------------------
async function streamOpenAI({ apiKey, system, messages, send, mcp }) {
  const payload = {
    model: CONFIG.openai.model,
    input: messages,
    max_output_tokens: CONFIG.openai.maxOutputTokens,
    stream: true,
  };
  if (system) payload.instructions = system;
  if (CONFIG.openai.reasoningEffort) {
    payload.reasoning = { effort: CONFIG.openai.reasoningEffort };
  }
  if (mcp && mcp.enabled) payload.tools = [openAiMcpTool(mcp.key)];

  const res = await fetch(CONFIG.openai.apiUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) throw await providerError(res);

  const logUnknown = makeUnknownEventLogger("OpenAI");
  let truncated = false;
  // The final usage object rides on response.completed (and on
  // response.incomplete when the reply was cut off).
  let rawUsage = null;

  // item_id -> tool name. The "call in progress" event doesn't carry the tool
  // name, only the item id, so the name is captured from the item's `added`
  // event and looked up when the call actually fires.
  const mcpCallNames = new Map();
  // Item ids that are MCP traffic rather than a message, so their argument
  // deltas can be recognised and dropped.
  const mcpItems = new Set();

  // The Responses API doesn't report usage until it finishes, so this early
  // event carries the model ID only — enough for the client to price its own
  // estimate if the reader hits Stop.
  await send({ type: "usage", partial: true, usage: null, model: CONFIG.openai.model });

  await readSSE(res, async (evt) => {
    const d = evt.data;
    if (!d || typeof d !== "object") return;

    const type = d.type || evt.event || "";

    // 1) Reply text. The documented event is response.output_text.delta with
    //    the chunk in `delta`; the regex and the `text` fallback are there so
    //    a renamed event or a moved field still produces text rather than
    //    silence. Reasoning deltas do NOT match (no "output_text" in name).
    const chunk = openAiTextDelta(type, d);
    if (chunk !== null) {
      if (chunk) await send({ type: "delta", text: chunk });
      return;
    }

    // 1b) MCP items. `response.output_item.added` is where an mcp_call first
    //     appears, and the only place the tool name is reliably present, so
    //     it is stashed against the item id. Nothing here is ever forwarded
    //     as text: arguments and results stay provider-internal.
    if (type === "response.output_item.added" && d.item && typeof d.item === "object") {
      const item = d.item;
      if (item.type === "mcp_call" || item.type === "mcp_list_tools") {
        if (item.id) {
          mcpItems.add(item.id);
          if (item.name) mcpCallNames.set(item.id, item.name);
        }
        // Announce as soon as the call appears — this is the earliest point
        // at which we know both that a call is happening and what it is.
        if (item.type === "mcp_call") {
          await send({
            type: "tool",
            server: item.server_label || SERANKING_SERVER_LABEL,
            name: toolLabel(item.name),
          });
        }
      }
      return;
    }

    // A call moving to "in progress" may be the first event that names it in
    // some API versions, and may name nothing at all in others — hence the
    // id -> name map. Only announce if `added` didn't already.
    if (/^response\.mcp_call/.test(type)) {
      const id = d.item_id || d.id;
      if (type.endsWith(".in_progress") && id && !mcpCallNames.has(id)) {
        mcpCallNames.set(id, null);
        await send({
          type: "tool",
          server: SERANKING_SERVER_LABEL,
          name: toolLabel(d.name || null),
        });
      }
      // Failures are logged, then reported as a friendly line. The turn
      // continues: the model can still answer without the tool.
      if (type.endsWith(".failed")) {
        console.log(`[OpenAI stream] MCP call failed — ${snippet(d)}`);
        await send({
          type: "error",
          message: "An SE Ranking lookup failed, so the answer may be missing that data.",
        });
      }
      return;                       // arguments/results are never forwarded
    }

    // Argument deltas for an MCP item: explicitly dropped.
    if (mcpItems.has(d.item_id) && /\.delta$/.test(type)) return;

    // 2) Terminal events. Advisory only — we finish when the body ends.
    if (type === "response.completed" || type === "response.incomplete") {
      const r = d.response || {};
      rawUsage = mergeRawUsage(rawUsage, r.usage);
      const reason = r.incomplete_details && r.incomplete_details.reason;
      if (
        type === "response.incomplete" ||
        r.status === "incomplete" ||
        reason === "max_output_tokens"
      ) {
        // Same tolerance as the non-streaming path: the output cap is the
        // only length limit we set, so a reasonless "incomplete" is one too.
        truncated =
          reason === "max_output_tokens" || reason === undefined || reason === null
            ? true
            : truncated;
      }
      return;
    }

    // 3) Failures reported as events rather than HTTP status.
    if (type === "response.failed" || type === "error" || type === "response.error") {
      console.error("OpenAI stream error event:", snippet(d));
      await send({
        type: "error",
        message: "The model stopped part-way through. Please try again.",
      });
      return;
    }

    // 4) Known bookkeeping events we intentionally ignore.
    if (
      OPENAI_IGNORED_EVENTS.has(type) ||
      /^response\.(reasoning|refusal)/.test(type) ||
      // MCP bookkeeping: tool listings and argument streaming. Recognised so
      // they don't spam the unknown-event log; never forwarded.
      /^response\.mcp_list_tools/.test(type)
    ) {
      return;
    }

    // 5) Anything else: log it once so you can see what actually arrives,
    //    then carry on. An unrecognised event must never break the stream.
    logUnknown(type, d);
  });

  await send({
    type: "done",
    truncated,
    usage: normalizeUsage("openai", rawUsage),
    model: CONFIG.openai.model,
  });
}

// Returns the text chunk for an output-text delta event, or null if this
// event isn't one. Tolerates the chunk living in `delta` or `text`.
function openAiTextDelta(type, d) {
  // MCP argument deltas (response.mcp_call.arguments.delta) must never be
  // mistaken for reply text — hence the explicit exclusion as well as the
  // "output_text" requirement.
  if (/^response\.mcp/.test(type)) return null;
  const isTextDelta =
    type === "response.output_text.delta" ||
    (/output_text/.test(type) && /\.delta$/.test(type));
  if (!isTextDelta) return null;
  if (typeof d.delta === "string") return d.delta;
  if (typeof d.text === "string") return d.text;
  return "";                   // recognised event, nothing usable in it
}

// Events the Responses API emits around the text that carry no reply content.
const OPENAI_IGNORED_EVENTS = new Set([
  "response.created",
  "response.in_progress",
  "response.queued",
  "response.output_item.added",
  "response.output_item.done",
  "response.content_part.added",
  "response.content_part.done",
  "response.output_text.done",
  "response.output_text.annotation.added",
]);

// ---------------------------------------------------------------------------
// SSE reading
//
// A network chunk can land anywhere — mid-line, mid-event — so the incoming
// bytes are buffered and only complete events (terminated by a blank line)
// are handed on. onEvent is awaited so writes can't outrun the reader.
// ---------------------------------------------------------------------------
async function readSSE(res, onEvent) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    // Normalize CRLF so the blank-line split below is the only thing we
    // need to reason about.
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");

    let i;
    while ((i = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, i);
      buffer = buffer.slice(i + 2);
      const evt = parseSSEBlock(block);
      if (evt) await onEvent(evt);
    }
  }

  // Flush a final event that arrived without its trailing blank line.
  buffer += decoder.decode().replace(/\r\n/g, "\n");
  if (buffer.trim()) {
    const evt = parseSSEBlock(buffer);
    if (evt) await onEvent(evt);
  }
}

// Turn one raw SSE block into { event, data }. `data` is the parsed JSON, or
// null when it isn't JSON (e.g. the "[DONE]" sentinel).
function parseSSEBlock(block) {
  let event = "";
  const dataLines = [];

  for (const line of block.split("\n")) {
    if (!line || line.startsWith(":")) continue;      // blank or comment
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "event") event = value;
    else if (field === "data") dataLines.push(value);
    // id / retry are ignored on purpose.
  }

  if (!dataLines.length) return event ? { event, data: null } : null;

  const raw = dataLines.join("\n");
  if (raw === "[DONE]") return { event, data: null };

  try {
    return { event, data: JSON.parse(raw) };
  } catch {
    return { event, data: null };
  }
}

// Logs each unrecognised event type once per request, with a payload sample,
// so an event-name change shows up in `wrangler pages dev` output instead of
// silently dropping text.
function makeUnknownEventLogger(label) {
  const seen = new Set();
  return (type, data) => {
    // Named `name`, not `key` — nothing key-shaped ever belongs in a log line.
    const name = type || "(no type)";
    if (seen.has(name)) return;
    seen.add(name);
    console.log(`[${label} stream] unrecognised event type: ${name} — ${snippet(data)}`);
  };
}

// Short, safe stringification for server-side logs. Everything that reaches
// a log goes through redact() first.
function snippet(obj) {
  try {
    return redact(JSON.stringify(obj)).slice(0, 400);
  } catch {
    return redact(String(obj)).slice(0, 400);
  }
}

// Last line of defence for logging: blank out anything that looks like an API
// key. Provider error bodies aren't supposed to echo the key back, but this
// costs nothing and means a future provider change can't turn a log line into
// a credential leak.
function redact(value) {
  const text = typeof value === "string" ? value : String(value);
  return text
    // sk-ant-..., sk-proj-..., sk-... and friends
    .replace(/\bsk-[A-Za-z0-9_\-]{6,}/g, "sk-[redacted]")
    // Bearer tokens, if one ever appears in a message
    .replace(/\bBearer\s+[A-Za-z0-9._\-]{8,}/gi, "Bearer [redacted]");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Build an Error carrying the HTTP status so friendlyError() can classify it.
// We read the body so it can be logged server-side, never returned to the client.
async function providerError(res) {
  let detail = "";
  try {
    detail = await res.text();
  } catch {
    /* ignore */
  }
  const err = new Error(`HTTP ${res.status}`);
  err.status = res.status;
  err.detail = detail; // server-side only, and redacted before logging
  return err;
}

// Map provider failures to a short, human-readable, non-leaky message.
function friendlyError(err) {
  const status = err && err.status;
  if (status === 400) {
    return "The model rejected the request — a parameter may not be supported.";
  }
  if (status === 401 || status === 403) {
    return "That key was rejected — check it's correct and active.";
  }
  if (status === 404) {
    return "That model wasn't found — the model name may be wrong, or your account may not have access to it.";
  }
  if (status === 429) {
    return "The model is rate-limited right now. Give it a moment and try again.";
  }
  if (status === 529 || status === 503) {
    return "The model is overloaded at the moment. Please try again shortly.";
  }
  if (status >= 500) {
    return "The model had a server error. Please try again.";
  }
  return "Something went wrong reaching the model. Please try again.";
}

// Small JSON response helper.
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}