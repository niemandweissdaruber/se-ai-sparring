// ---------------------------------------------------------------------------
// SE AI Sparring — Pages Function
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
// Anthropic: Claude Opus 4.8 via the Messages API.
// OpenAI:    GPT-5.6 Sol via the RESPONSES API (not chat/completions — the
//            current model family is served through /v1/responses).
//
// The token caps are the ONLY place output length is limited. Raising them
// makes truncation rarer but never impossible, which is why every provider
// call below also reports whether the reply was actually cut off.
const CONFIG = {
  anthropic: {
    model: "claude-opus-4-8",
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

// --- REVIEW MODES ---------------------------------------------------------
// A review is one of two things, and the difference is not cosmetic — it
// changes what the reviewer is being asked:
//
//   full     the reviewer judges a whole answer. When that answer is itself a
//            rebuttal, the implicit question is "does this respond to your
//            earlier critique?" — which is exactly right there.
//
//   passage  the reviewer judges ONE highlighted passage and nothing else.
//            The implicit question is "what do you think about this specific
//            advice?" — so the earlier critique must NOT be presented as the
//            thing being answered, or the reviewer grades the passage as a
//            reply to itself. It travels as background inside the system
//            prompt instead, explicitly labelled as not-under-review.
//
// Only a CRITIQUE is shaped by this. Nothing sends a rebuttal in passage mode:
// a passage review is now read in the panel and either applied to the answer
// or not, so there is no per-paragraph reply to prompt for.
//
// Both providers are handed the SAME `system` string and the SAME `messages`
// array (see callAnthropic / callOpenAI, which differ only in where each API
// wants the system prompt to sit). There is deliberately no provider-specific
// wording anywhere in this file — a passage review reads identically whether
// Claude or ChatGPT is the reviewer.
const REVIEW_MODES = ["full", "passage"];

// Upper bounds on every free-text field a passage review carries. A selection
// is user-driven and could be an entire answer; these caps keep one request
// from ballooning without changing what a normal highlight looks like.
const PASSAGE_LIMITS = {
  selectionText: 4000,
  contextBefore: 1200,
  contextAfter: 1200,
  sectionHeading: 200,
  userNote: 500,
  priorCritique: 6000,
};

// Coerce to a trimmed string of at most `max` characters. Context is clipped
// from the END for text that precedes the passage and from the START for text
// that follows it, so what survives is always the part nearest the highlight.
function clampText(value, max, keep = "start") {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return keep === "end"
    ? "…" + trimmed.slice(-max)
    : trimmed.slice(0, max) + "…";
}

// Normalize the passage payload once, up front, so neither the prompt builder
// nor the message builder has to think about missing or oversized fields.
function normalizePassage(raw) {
  const p = raw && typeof raw === "object" ? raw : {};
  return {
    selectionText: clampText(p.selectionText, PASSAGE_LIMITS.selectionText),
    contextBefore: clampText(p.contextBefore, PASSAGE_LIMITS.contextBefore, "end"),
    contextAfter: clampText(p.contextAfter, PASSAGE_LIMITS.contextAfter),
    sectionHeading: clampText(p.sectionHeading, PASSAGE_LIMITS.sectionHeading),
    userNote: clampText(p.userNote, PASSAGE_LIMITS.userNote),
  };
}

// A passage review comes in two shapes, and which one you get depends on
// whether the reader wrote a comment alongside the highlight.
//
//   no comment   the reviewer judges the passage and returns a verdict. This
//                is a second opinion: the reader wants to know whether the
//                claim holds.
//
//   a comment    the reader has said something, and the reviewer is answering
//                THEM. Asking for a verdict here would be the wrong question —
//                it invites the model to grade a paragraph when what was
//                actually asked was "is this person right?". So the verdict
//                and the whole Format block are absent from that prompt, and
//                the client renders no stance line for one either.
//
// Both travel as `reviewMode: "passage"`; the presence of userNote is the
// switch. Nothing else about the request changes.
function buildPassageSystemPrompt({ question, passage, priorCritique }) {
  return passage.userNote
    ? buildPassageCommentPrompt({ question, passage, priorCritique })
    : buildPassageVerdictPrompt({ question, passage, priorCritique });
}

// Where the passage sits, plus the reviewer's own earlier critique as labelled
// background. Shared by both shapes; the original question is placed by each
// caller, because the two want it in different positions.
//
// Empty fields are omitted rather than rendered as empty quotes: an empty
// `Before: """"""` reads like "there is nothing before this", which is a
// claim we can't make when the highlight simply couldn't be located.
function passageContextParts({ passage, priorCritique }) {
  const parts = [];

  const where = [];
  if (passage.sectionHeading) where.push(`Section: ${passage.sectionHeading}`);
  if (passage.contextBefore) where.push(`Before: """${passage.contextBefore}"""`);
  if (passage.contextAfter) where.push(`After: """${passage.contextAfter}"""`);
  if (where.length) {
    parts.push(
      "Where it sits (context only, not under review):\n" + where.join("\n")
    );
  }

  // The earlier critique goes HERE and nowhere else — never as the message
  // being answered. The heading is doing real work: without it the reviewer
  // reliably reads the passage as a reply to its own previous points.
  const background = clampText(priorCritique, PASSAGE_LIMITS.priorCritique);
  if (background) {
    parts.push(
      "Background — your earlier critique (NOT what you are reviewing now):\n" +
      `"""${background}"""`
    );
  }

  return parts;
}

// SHAPE 1 — no comment. A second opinion on one passage, ending in a verdict.
function buildPassageVerdictPrompt({ question, passage, priorCritique }) {
  const parts = [];

  parts.push(
    "You are giving a second opinion on ONE SPECIFIC PASSAGE the user\n" +
    "highlighted. You are not reviewing the whole answer."
  );

  if (question) parts.push(`The user's original question: ${question}`);

  parts.push(`The highlighted passage:\n"""${passage.selectionText}"""`);

  parts.push(...passageContextParts({ passage, priorCritique }));

  parts.push(
    "Rules:\n" +
    "- Judge only the highlighted passage.\n" +
    "- This passage is NOT a response to any earlier critique of yours. Do not\n" +
    "  evaluate it as one.\n" +
    "- Do not fault it for omitting things covered elsewhere in the answer or\n" +
    "  outside the highlight.\n" +
    "- If your earlier critique already covered this point, say so in one line,\n" +
    "  then give your view anyway."
  );

  parts.push(
    "Format:\n" +
    "- One-line verdict: Agree / Partly agree / Disagree / Depends on X\n" +
    "- 2-4 bullets, each about this passage only\n" +
    "- One closing line: what evidence would settle it\n" +
    "Under 200 words."
  );

  return parts.join("\n\n");
}

// SHAPE 2 — the reader commented. This is a turn in a conversation, so the
// reviewer is answering a person, not grading a paragraph. Deliberately
// absent: any instruction to take a stance, produce a verdict, or fill a
// verdict field.
function buildPassageCommentPrompt({ question, passage, priorCritique }) {
  const parts = [];

  parts.push(
    "The following passage was written by another AI model.\n" +
    `"""${passage.selectionText}"""`
  );

  parts.push(`The user has responded to it:\n"""${passage.userNote}"""`);

  if (question) parts.push(`The user's original question was: ${question}`);

  parts.push(...passageContextParts({ passage, priorCritique }));

  parts.push(
    "Address what the user raised, using the passage as context. Investigate\n" +
    "their point using the tools available to you."
  );

  parts.push(
    "If the user is right and the passage is wrong, say so. If the user is\n" +
    "mistaken, say so directly. If you cannot verify their point, say it is\n" +
    "unverified rather than reasoning your way to a conclusion."
  );

  parts.push(
    "Do not agree with the user because they are the user. Do not defer to the\n" +
    "passage because it was written first."
  );

  return parts.join("\n\n");
}

// --- ATTACHMENTS ----------------------------------------------------------
// Images and PDFs ride along with a user turn as
//   { id, kind: "image" | "pdf", name, mediaType, base64 }
// which is exactly what the client produces. Nothing is stored here and
// nothing is written anywhere — the bytes exist for the length of one
// upstream call, the same contract the API key has.
//
// The client already enforces these limits, but it is a browser and therefore
// not to be trusted: everything is re-checked here. A request that violates a
// limit is refused rather than trimmed, so the caller never silently gets a
// different question answered than the one it asked.
const ATTACHMENT_LIMITS = {
  perMessage: 3,
  // Anthropic's per-image ceiling is 5MB of base64. PDFs are capped at 32MB
  // by the API; we stop at 20MB of raw file, which is ~26.7MB of base64.
  imageBase64: 5 * 1024 * 1024,
  pdfBase64: Math.ceil((20 * 1024 * 1024 * 4) / 3),
  // Whole-request ceiling, base64 bytes across every attachment on every turn.
  totalBase64: Math.ceil((20 * 1024 * 1024 * 4) / 3),
};

const IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const PDF_MEDIA_TYPE = "application/pdf";

// Validate one attachment. Returns an error STRING (client-safe) or null.
function attachmentError(att) {
  if (!att || typeof att !== "object") return "Malformed attachment.";
  if (typeof att.base64 !== "string" || !att.base64) return "Attachment has no data.";

  if (att.kind === "image") {
    if (!IMAGE_MEDIA_TYPES.includes(att.mediaType)) {
      return "Unsupported image type — PNG, JPEG, GIF and WebP only.";
    }
    if (att.base64.length > ATTACHMENT_LIMITS.imageBase64) {
      return "That image is too large — images must be under 5MB once encoded.";
    }
    return null;
  }

  if (att.kind === "pdf") {
    if (att.mediaType !== PDF_MEDIA_TYPE) return "Malformed PDF attachment.";
    if (att.base64.length > ATTACHMENT_LIMITS.pdfBase64) {
      return "That PDF is too large — the limit is 20MB.";
    }
    return null;
  }

  return "Images and PDFs only.";
}

// Validate every attachment on every turn, and the request as a whole.
// Returns an error string or null.
function validateAttachments(messages) {
  let total = 0;
  for (const msg of messages) {
    const list = attachmentsOf(msg);
    if (!list.length) continue;
    if (list.length > ATTACHMENT_LIMITS.perMessage) {
      return `Up to ${ATTACHMENT_LIMITS.perMessage} attachments per message.`;
    }
    for (const att of list) {
      const err = attachmentError(att);
      if (err) return err;
      total += att.base64.length;
    }
  }
  if (total > ATTACHMENT_LIMITS.totalBase64) {
    return "Those attachments are too large together — the limit is about 20MB per request.";
  }
  return null;
}

function attachmentsOf(msg) {
  return msg && Array.isArray(msg.attachments) ? msg.attachments : [];
}

// True when any turn carries a PDF. Used only to recognise the page-limit
// rejection, which is otherwise indistinguishable from any other 400.
function hasPdfAttachment(messages) {
  return messages.some((m) => attachmentsOf(m).some((a) => a && a.kind === "pdf"));
}

// --- Provider shaping ------------------------------------------------------
// One attachment, in the shape each provider's API wants.
//
// The two APIs disagree about almost everything here — Anthropic nests the
// bytes under `source`, the Responses API wants a data: URL — but they must
// agree about WHAT is being sent. shapeMessages() checks that below.
function shapeAttachment(provider, att) {
  if (provider === "anthropic") {
    return att.kind === "image"
      ? {
          type: "image",
          source: { type: "base64", media_type: att.mediaType, data: att.base64 },
        }
      : {
          type: "document",
          source: { type: "base64", media_type: PDF_MEDIA_TYPE, data: att.base64 },
        };
  }
  // OpenAI Responses API.
  return att.kind === "image"
    ? { type: "input_image", image_url: `data:${att.mediaType};base64,${att.base64}` }
    : {
        type: "input_file",
        filename: att.name || "document.pdf",
        file_data: `data:${PDF_MEDIA_TYPE};base64,${att.base64}`,
      };
}

// The provider's name for a plain text block inside a multi-part user turn.
function shapeText(provider, text) {
  return provider === "anthropic"
    ? { type: "text", text }
    : { type: "input_text", text };
}

// Turn the wire format into the provider's message array.
//
// A turn with no attachments keeps its plain-string content, so a request
// without attachments is byte-for-byte what this endpoint sent before they
// existed. Only a turn that actually carries files becomes a block array —
// and there the attachments come FIRST, before the user's text, for both
// providers: a model reads the question last, with the material already in
// front of it.
function shapeMessages(provider, messages) {
  return messages.map((msg) => {
    const list = attachmentsOf(msg);
    if (!list.length) {
      return { role: msg.role, content: msg.content };
    }
    return {
      role: msg.role,
      content: [
        ...list.map((att) => shapeAttachment(provider, att)),
        shapeText(provider, msg.content),
      ],
    };
  });
}

// Both models must be looking at the same thing, or a "second opinion" is
// worthless — a reviewer that can't see the screenshot invents problems with
// it. The shapes differ by design, so compare the only things that must
// match: how many attachments each turn carries, and of what kind, in order.
//
// This is a self-check on the code above, not on user input (which is already
// validated), so it logs rather than failing the request: a shaping bug should
// be visible in the logs without taking the app down.
function attachmentFingerprint(shaped, provider) {
  return shaped
    .map((msg) => {
      if (!Array.isArray(msg.content)) return "-";
      return msg.content
        .map((block) => {
          if (provider === "anthropic") {
            if (block.type === "image") return "image";
            if (block.type === "document") return "pdf";
          } else {
            if (block.type === "input_image") return "image";
            if (block.type === "input_file") return "pdf";
          }
          return null;
        })
        .filter(Boolean)
        .join(",");
    })
    .join("|");
}

function shapeMessagesChecked(provider, messages) {
  const mine = shapeMessages(provider, messages);
  if (!messages.some((m) => attachmentsOf(m).length)) return mine;

  const other = provider === "anthropic" ? "openai" : "anthropic";
  const theirs = shapeMessages(other, messages);
  const a = attachmentFingerprint(mine, provider);
  const b = attachmentFingerprint(theirs, other);
  if (a !== b) {
    console.warn(
      "[attachments] provider shaping disagrees — the two models would not " +
      `see the same files. ${provider}=${a} ${other}=${b}`
    );
  }
  return mine;
}

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

  const {
    provider, mode, messages, question, targetText, stream, useMcp,
    // Review shaping. `reviewMode` is the 'full' | 'passage' distinction
    // described under REVIEW_MODES; `passage` and `priorCritique` are only
    // read when it is 'passage'. Absent means 'full', which is byte-for-byte
    // the behaviour this endpoint had before passage reviews existed.
    reviewMode, passage, priorCritique,
    // Attachments for the turn this request builds itself (critique mode).
    // For chat and rebuttal they ride on the individual `messages` entries.
    attachments,
  } = body || {};

  // Optional per-request output cap, used by small utility calls such as chat
  // title generation. Clamped: it can only ever LOWER the configured ceiling,
  // never raise it, so a caller cannot enlarge the bill.
  const requestedMax = Number(body && body.maxTokens);
  const maxTokensOverride =
    isFinite(requestedMax) && requestedMax > 0
      ? Math.min(Math.round(requestedMax), CONFIG[provider === "anthropic" ? "anthropic" : "openai"][provider === "anthropic" ? "maxTokens" : "maxOutputTokens"])
      : null;

  // Validate provider.
  if (provider !== "anthropic" && provider !== "openai") {
    return json({ error: "bad_request", message: "Unknown provider." }, 400);
  }

  // Validate mode.
  if (!["chat", "critique", "rebuttal"].includes(mode)) {
    return json({ error: "bad_request", message: "Unknown mode." }, 400);
  }

  // Validate the review mode. Unset is allowed and means "full".
  if (reviewMode !== undefined && !REVIEW_MODES.includes(reviewMode)) {
    return json({ error: "bad_request", message: "Unknown review mode." }, 400);
  }
  const review = reviewMode === "passage" ? "passage" : "full";

  // A passage review with nothing highlighted has no subject. Fail loudly
  // rather than quietly degrading to a full review of an empty string.
  const passageFields = review === "passage" ? normalizePassage(passage) : null;
  if (review === "passage" && mode === "critique" && !passageFields.selectionText) {
    return json(
      { error: "bad_request", message: "A passage review needs a highlighted passage." },
      400
    );
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
  const builtMessages = buildMessages({
    mode, messages, question, targetText, review, passage: passageFields,
    attachments,
  });

  // Re-validate everything the client sent. The browser enforces the same
  // limits, but it is a browser: a hand-rolled request must not be able to
  // push a 200MB base64 blob through this endpoint.
  const attachmentProblem = validateAttachments(builtMessages);
  if (attachmentProblem) {
    return json({ error: "bad_request", message: attachmentProblem }, 400);
  }
  // Shaped once, here, so all four call paths below receive a provider-ready
  // array and none of them has to know attachments exist.
  const providerMessages = shapeMessagesChecked(provider, builtMessages);
  // Only used to recognise Anthropic's page-limit rejection, which arrives as
  // an ordinary 400.
  const pdfPresent = hasPdfAttachment(builtMessages);
  const system = systemPromptFor({
    mode, review, question, passage: passageFields, priorCritique,
  });

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
      messages: providerMessages,
      mcp,
      pdfPresent,
    });
  }

  try {
    // Both callers return { text, truncated }. `truncated` means the model hit
    // the output cap mid-reply — the text is still good, just incomplete, so
    // we return it with the flag instead of throwing. The client shows a
    // notice and offers a "Continue" button.
    let result;
    if (provider === "anthropic") {
      result = await callAnthropic({ apiKey, system, messages: providerMessages, mcp, maxTokensOverride });
    } else {
      result = await callOpenAI({ apiKey, system, messages: providerMessages, mcp, maxTokensOverride });
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
        message: friendlyError(err, { pdfPresent }),
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
function buildMessages({ mode, messages, question, targetText, review, passage, attachments }) {
  // Only ever attach to a turn this function CREATES. A chat or rebuttal turn
  // carries its own attachments on the message itself.
  const own = Array.isArray(attachments) && attachments.length ? attachments : null;

  // A passage critique carries everything — passage, surrounding context, the
  // user's note, the earlier critique as background — in the system prompt, so
  // the user turn is a bare instruction. In particular the earlier critique is
  // NOT here: presenting it as the message being answered is precisely the
  // confusion this mode exists to remove.
  if (mode === "critique" && review === "passage") {
    return [
      {
        role: "user",
        content: "Give your second opinion on the highlighted passage.",
        ...(own ? { attachments: own } : {}),
      },
    ];
  }

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
        // The reviewer sees the same files the answer was written against.
        // Without them it reviews a description of the evidence rather than
        // the evidence, and reliably invents faults.
        ...(own ? { attachments: own } : {}),
      },
    ];
  }

  // chat and rebuttal both send the running conversation history as-is.
  // For rebuttal, the caller has already appended a user turn containing the
  // critique text; the rebuttal system prompt does the framing.
  return Array.isArray(messages) ? messages : [];
}

// Which system prompt this request gets. The only place review mode changes
// the framing — and it changes it identically for both providers, because
// both are handed this one string.
function systemPromptFor({ mode, review, question, passage, priorCritique }) {
  // Review mode only ever changes a CRITIQUE. It used to switch the rebuttal
  // prompt too, back when sending a passage review back asked the author to
  // revise that one paragraph; that call no longer exists, so a rebuttal is
  // always a reply to a whole-answer review.
  if (review === "passage" && mode === "critique") {
    return buildPassageSystemPrompt({ question, passage, priorCritique });
  }
  return SYSTEM_PROMPTS[mode];
}

// ---------------------------------------------------------------------------
// Anthropic REST call — POST /v1/messages
// ---------------------------------------------------------------------------
async function callAnthropic({ apiKey, system, messages, mcp, maxTokensOverride }) {
  const payload = {
    model: CONFIG.anthropic.model,
    max_tokens: maxTokensOverride || CONFIG.anthropic.maxTokens,
    messages, // [{ role: "user" | "assistant", content: "..." }]
    // Opus 4.8 runs WITHOUT thinking unless this is set explicitly — unlike
    // Opus 5, where adaptive thinking is the default. Omitted, replies lose
    // reasoning AND the model tends to write its reasoning into the visible
    // answer, which the streaming path below would render as answer text.
    thinking: { type: "adaptive" },
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
async function callOpenAI({ apiKey, system, messages, mcp, maxTokensOverride }) {
  const payload = {
    model: CONFIG.openai.model,
    input: messages, // [{ role: "user" | "assistant", content: "..." }]
    max_output_tokens: maxTokensOverride || CONFIG.openai.maxOutputTokens,
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
// header; a request without one never went through it.
//
// localhost is always exempt (there is no Access in front of a dev server).
//
// A deployment that has NOT set up Access yet can opt out explicitly by
// setting the env var ALLOW_MCP_WITHOUT_ACCESS=true. That is a deliberate,
// risk-accepted choice, not a default: without Access, anyone who finds the
// URL can use this app and spend SE Ranking credits on the operator's key
// (they bring their own provider key, but not ours). Remove the variable the
// moment Access is in place — and remember Access must BYPASS /api/mcp/*, or
// Anthropic's server-to-server calls to the proxy will be challenged.
const ENFORCE_ACCESS_JWT = true;

function accessCheckRequired(env, request) {
  if (!ENFORCE_ACCESS_JWT) return false;
  if (isLocalRequest(request)) return false;
  const optOut = env && env.ALLOW_MCP_WITHOUT_ACCESS;
  if (typeof optOut === "string" && optOut.trim().toLowerCase() === "true") {
    return false;
  }
  return true;
}

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
  // See accessCheckRequired() for the localhost and opt-out exemptions.
  if (accessCheckRequired(env, request)) {
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
async function handleStreamRequest(context, { provider, apiKey, system, messages, mcp, pdfPresent }) {
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
        await send({ type: "error", message: friendlyError(err, { pdfPresent }) });
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
    // Explicit for the same reason as in callAnthropic() — Opus 4.8 does not
    // think unless asked. Thinking deltas are ignored below (display defaults
    // to "omitted" on this model, so they carry no text anyway).
    thinking: { type: "adaptive" },
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

// Anthropic caps PDFs at 100 pages and refuses longer ones with an ordinary
// 400. Counting pages in the browser is not worth doing (it means parsing the
// PDF), so the rejection is recognised here instead and translated into the
// one sentence that actually tells the reader what to do about it.
//
// Matched on the provider's own words, not on a status code alone: a 400 with
// a PDF attached could just as easily be a malformed request, and calling that
// a page-limit problem would send someone off splitting a file for no reason.
function isPdfPageLimitError(err) {
  const detail = err && typeof err.detail === "string" ? err.detail : "";
  if (!detail) return false;
  return /\bpages?\b/i.test(detail) &&
         /\b(exceed|limit|maximum|too many|at most)\b/i.test(detail);
}

// Map provider failures to a short, human-readable, non-leaky message.
// `ctx.pdfPresent` says whether this request carried a PDF at all.
function friendlyError(err, ctx = {}) {
  const status = err && err.status;
  if (status === 400) {
    if (ctx.pdfPresent && isPdfPageLimitError(err)) {
      return "PDF too long — Claude accepts up to 100 pages. Split it and attach the part you need.";
    }
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