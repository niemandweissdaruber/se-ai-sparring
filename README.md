# SE AI Sparring

A chat tool where one AI answers and a second AI critiques that answer — so you never have to trust a single model.

- **Primary model** runs the main chat.
- **Critic model** gives a "second opinion" on any reply, in one of two modes.
- **Send back** feeds the critique to the primary model for a rebuttal.
- **Toggle** which model is primary at any time.

### Two review modes

The panel badges which one is running, because they ask the reviewer different questions.

| | **Full review** | **Passage review** |
|---|---|---|
| Started by | the **Second opinion** button on a reply | highlighting text inside a reply |
| The reviewer is asked | *does this answer hold up?* — and, on a rebuttal, *does it respond to your earlier critique?* | *what do you think about this specific advice?* |
| Earlier critique | sent as the message being answered | sent as **background only**, labelled "NOT what you are reviewing now" |
| Extra input | — | an optional "anything you're unsure about?" note, asked **before** the request so it costs nothing extra |
| **Send back** produces | a new Rebuttal message in the thread | an inline note attached to the highlighted passage — the reply revises or defends *that passage only* |

A passage review also carries the text on either side of the highlight and the
nearest heading above it, as context the reviewer is told not to judge. Rebuttals
inherit the mode of the review they answer, and both providers are handed exactly
the same system prompt and message list — there is no provider-specific wording.

**Bring your own key.** The app ships with no API keys. Each visitor pastes their own
Anthropic and/or OpenAI key in Settings; the key is stored in that person's browser and
sent with their own requests. Whoever deploys this never pays for anyone else's usage.
One key is enough to chat — second opinions need both.

---

## How it's built

| Path | What it is |
|------|-----------|
| `public/index.html` | The entire frontend — inline CSS + JS, no build step, no npm. `public/` is also the static-asset directory the Worker serves, so it holds **only** what should be public. |
| `worker/index.js` | The Worker entry point. Dispatches the two API routes by path and falls through to the static assets. |
| `wrangler.toml` | Worker config: entry point, asset directory. Secrets are **not** declared here. |
| `functions/api/chat.js` | The `/api/chat` handler. Forwards each call to the provider using the key from the request header. Holds no provider keys of its own. It keeps its Pages-style `context` signature, which is why it still lives under `functions/`. |
| `assets/` | Provider logo files (see `assets/README.md`). |
| `README.md` | This file. |

**Where keys live:** in each user's own browser (`localStorage`), never on the server. Every
request carries the caller's key in an `x-provider-key` header; the Worker uses it for that
one upstream call and discards it. Nothing is stored, cached, or logged — anything sampled
into a server log passes through `redact()` first. The Worker reads **no** environment
variables for keys, deliberately: there is no fallback that could spend the operator's credit.

### Swapping models

Both model IDs live in a single `CONFIG` constant at the top of `functions/api/chat.js`:

```js
const CONFIG = {
  anthropic: { model: "claude-sonnet-4-20250514", /* … */ },
  openai:    { model: "gpt-4o", /* … */ },
};
```

Change the `model` strings there — nothing else needs to move. Verify the exact
current model IDs against each provider's docs.

---

## Run it locally

You need [Wrangler](https://developers.cloudflare.com/workers/wrangler/) (Cloudflare's CLI). It runs the Worker locally so `/api/chat` works.

### 1. Install Wrangler

```bash
npm install -g wrangler
```

(Or use it without installing globally via `npx wrangler …`.)

### 2. Start the dev server

```bash
npx wrangler dev
```

`wrangler dev` reads `wrangler.toml`, so it needs no arguments: it serves `public/` as
static assets and routes `/api/chat` to the Worker.

Wrangler prints a local URL (typically `http://localhost:8787`). Open it, click the gear icon,
and paste your own key(s) — exactly as any other visitor would. No `.dev.vars` file is needed:
the Worker ignores environment variables entirely.

If you have an old `.dev.vars` from a previous version, it is now unused. Delete it.

---

## Deploy to Cloudflare

This deploys as a **Worker**, not a Pages project. Cloudflare now creates Workers by
default, and Workers do not use the Pages `functions/` file-based routing convention —
`worker/index.js` wires up the two API routes explicitly and hands everything else to the
static-asset binding. See the comments at the top of `wrangler.toml`.

### Option A — direct deploy with Wrangler

```bash
npx wrangler deploy
```

Everything it needs is already in `wrangler.toml`: the entry point (`worker/index.js`) and
the static-asset directory (`public/`). There is no build step and no arguments to pass.

If the command fails asking for `CLOUDFLARE_API_TOKEN`, your saved login has expired —
run `npx wrangler login` first.

### Option B — Git-connected (build on push)

Push the repo to GitHub/GitLab and connect it to the Worker from the Cloudflare
dashboard, under **Workers & Pages**. Leave the build command empty; `wrangler.toml`
supplies the rest.

### ⚠️ Before deploying publicly: delete the API key environment variables

Earlier versions of this app read `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` from the Cloudflare
environment. **That is gone, and the variables must be deleted.**

1. Cloudflare dashboard → **Workers & Pages → your Worker → Settings**, under the
   variables/secrets section.
2. Delete `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` wherever they appear.
3. Redeploy.

The current Worker never reads them, so leaving them in place would not actually let
strangers spend your credit — but a stale secret sitting in a public project's settings is
a liability with no upside. Remove them. And if those keys were ever live on a public
deployment, revoke and reissue them in the provider dashboards.

Nothing else needs configuring: the site is static, each visitor brings their own key, and the
two models keep each other honest.

---

## Notes

- Conversation state is kept **in memory only** (v1). Refreshing the page starts a fresh conversation. No database, no `localStorage`.
- The code is heavily commented — tweak it by hand freely.

---

## SE Ranking data (optional grounding)

A header toggle, **SE Ranking data**, off by default. When it's on, every generation
turn — the initial answer, the second opinion, the rebuttal, and any follow-up — is
allowed to call SE Ranking's MCP server, so both models reason over real SEO data
instead of memory. When it's off the app behaves exactly as it did before: no MCP
fields are added to either provider request and no connection to SE Ranking is made.

Both providers connect to `https://api.seranking.com/mcp` **directly**. This app is
not a proxy — it only supplies the credential.

### How each provider connects

SE Ranking's MCP server does not accept a static API key as a bearer token — the MCP
`initialize` handshake returns **401** and points at an OAuth flow it wants instead.
The same key authenticates the whole session when sent as **`X-Api-Key`**. The two
providers differ in whether they can do that:

| Provider | Route | Auth |
|---|---|---|
| **ChatGPT** | Direct to `api.seranking.com/mcp` | `X-Api-Key` — OpenAI's MCP tool accepts arbitrary `headers` |
| **Claude** | Through our own proxy at `/api/mcp/seranking` | Bearer `MCP_PROXY_SECRET` in, swapped for `X-Api-Key` out |

Anthropic's connector can only send `authorization_token` (always as a Bearer) and
rejects a custom `headers` field outright — *"mcp_servers.0.headers: Extra inputs are
not permitted"*. Its OAuth server advertises only `authorization_code` and
`refresh_token` grants (no `client_credentials`), so a token can't be minted
non-interactively either. The proxy exists solely to bridge that gap.

**`functions/api/mcp/seranking.js`** is a transparent MCP passthrough, not an open
proxy:

* The upstream is a **fixed constant**. There is no caller-supplied target, no path
  passthrough, no query-driven destination.
* Every request must present `Authorization: Bearer <MCP_PROXY_SECRET>` — a wrong
  secret, a missing header, or even SE Ranking's own key all get a flat 401.
* The incoming `Authorization` is **deleted** before forwarding (a Bearer reaching SE
  Ranking is exactly what 401s), and `X-Api-Key` is set from `SERANKING_API_KEY`.
  `Host`, `cf-*` and the Cloudflare Access JWT are stripped too.
* `Mcp-Session-Id`, `Mcp-Protocol-Version`, `Accept` and `Content-Type` pass through
  in **both** directions, and the upstream response is returned unread so
  `text/event-stream` streams unbuffered. POST, GET and DELETE are all forwarded.
* Neither secret ever appears in a response body or a log line.

> **Claude grounding is only verifiable on a deployed URL.** Anthropic calls the proxy
> from its own cloud, which cannot reach `localhost`. With the toggle on against a
> local dev server, Claude turns return a clear message saying so rather than hanging.
> ChatGPT grounding works anywhere, including locally.

### The SE Ranking key is server-side only

`SERANKING_API_KEY` lives in the Cloudflare environment and is used only inside the
provider request bodies. It is never sent to the browser, never logged, and never
part of any response the Worker returns. There is no SE Ranking field in Settings,
because the browser never sees that key.

**Use a restricted, read-only SE Ranking API key.** SE Ranking supports read-only
keys — issue one for this deployment rather than reusing a full-access key.

### Read-only twice over

Beyond the key's own restrictions, the tool surface is locked down in code. The MCP
server publishes **217** tools, **84** of which mutate account data
(`create*`, `add*`, `update*`, `delete*`, `move*`, `share*`, `import*`, `recheck*`,
`run*`, `set*`). None of them is reachable. Exactly five read-only tools are exposed,
listed in one constant (`SERANKING_TOOLS` in `functions/api/chat.js`) and shared by
both providers:

| Tool | Covers |
|------|--------|
| `DATA_getDomainOverviewByCountry` | Domain overview, per country/database |
| `DATA_getDomainKeywords` | Organic keywords a domain ranks for |
| `DATA_getKeywordsMetrics` | Keyword research — volume, KD, CPC, intent |
| `DATA_getBacklinksSummary` | Backlink profile summary |
| `DATA_getAiSearchOverview` | AI search visibility |

Every name was taken verbatim from a live `tools/list` against the server — none is
guessed. If you add one, confirm the exact name the same way and confirm it only
reads. Anthropic is additionally configured deny-by-default
(`default_config: { enabled: false }`), so a tool that isn't on the list cannot be
called even if the server starts advertising it.

> **`DATA_getSerpResults` is deliberately excluded.** It queues a SERP task
> server-side, consumes SERP credits, and polls for up to five minutes — long enough
> to stall a generation turn. Every tool above returns immediately from stored data.

### Required deploy step: put it behind Cloudflare Access

This tool exposes a company SE Ranking key to whoever can reach the page, so the
deployment **must** sit behind Cloudflare Access, restricted to SE Ranking company
accounts.

1. Cloudflare dashboard → **Zero Trust → Access → Applications → Add an application**.
2. Type **Self-hosted**, pointed at this Worker's domain.
3. Add a policy: **Allow**, with an *Emails ending in* rule for your company domain
   (or an identity-provider group). Do not leave a bypass policy in place.
4. Save, then confirm an incognito window is challenged before the page loads.

#### ⚠️ Access must BYPASS `/api/mcp/*`

Anthropic calls the proxy **server-to-server from its own cloud** and cannot complete
an interactive login, so an Access policy covering that path breaks Claude grounding.
Add a second policy to the same application:

* **Action:** Bypass · **Include:** Everyone · **Path:** `/api/mcp/*`

That path is not left unprotected. It requires the bearer `MCP_PROXY_SECRET`, it can
only ever talk to one fixed upstream, the SE Ranking key it uses is restricted and
read-only, and the Anthropic toolset exposes only the five whitelisted tools. Keep
Access enforcing on every other path, `/api/chat` included.

#### Running before Access is set up

A deployment that hasn't configured Access yet can opt out of the JWT check with
`ALLOW_MCP_WITHOUT_ACCESS=true`. That is a deliberate, risk-accepted setting, not a
default: **without Access, anyone who finds the URL can use the app and spend SE
Ranking credits on your key** (they bring their own provider key, but not yours).
Delete the variable the moment Access is in place.

As defence in depth the chat handler also rejects MCP-enabled requests that arrive
without Cloudflare Access's `Cf-Access-Jwt-Assertion` header — so if Access is ever
removed or misconfigured, the toggle stops working rather than quietly leaking the
key's capabilities. `localhost` is exempt so local development still works. The
switch is `ENFORCE_ACCESS_JWT` in `functions/api/chat.js`.

### Configuring the keys

Three variables, all **encrypted** (Secret) in production:

| Variable | Needed for | Notes |
|---|---|---|
| `SERANKING_API_KEY` | Both providers | Restricted, read-only SE Ranking key |
| `MCP_PROXY_SECRET` | Claude only | Any random string; rotate freely |
| `MCP_PROXY_URL` | Claude, optional | Absolute URL of the deployed proxy — e.g. `https://se-ai-sparring.<your-subdomain>.workers.dev/api/mcp/seranking` (**replace with your actual Worker host**). Usually best left **unset**: it then falls back to the request's own origin, so the proxy follows whatever host the project deploys to and preview deployments work unconfigured. Set it only if the proxy must live on a different host from the app. |

**Production** — Cloudflare dashboard → **Workers & Pages → your Worker → Settings
→ Environment variables**, then redeploy.

**Local development** — add them to `.dev.vars`:

```
SERANKING_API_KEY=your-read-only-se-ranking-key
MCP_PROXY_SECRET=any-long-random-string
```

Generate a secret with `python3 -c "import secrets;print(secrets.token_urlsafe(32))"`.

If Claude grounding is requested and `MCP_PROXY_SECRET` is missing, the app says so
plainly — ChatGPT turns are unaffected.

If the toggle is on and no key is configured, the app says so plainly instead of
quietly answering without the data you asked for.

### Cost and latency

Tool results come back as ordinary input tokens, so they're billed like any other
tokens and the existing cost tracking already covers them. Expect **noticeably higher
cost and latency** when tools fire — and "noticeably" is doing real work in that
sentence. A measured example, the acceptance query answered by ChatGPT:

| | Toggle off | Toggle on |
|---|---|---|
| Input tokens | ~20 | **141,263** (one turn, uncached) |
| Cost of that turn | ~$0.01 | **~$0.57** |

A full answer → critique → rebuttal cycle on that query cost **~$0.36** with caching
helping on later turns. Budget accordingly, and leave the toggle off for questions
that don't need live data. A small chip (`🔧 SE Ranking · organic keywords`) appears above
each reply that used live data, so it's always visible when a turn was grounded.

