# AI vs AI

A chat tool where one AI answers and a second AI critiques that answer — so you never have to trust a single model.

- **Primary model** runs the main chat.
- **Critic model** gives a "second opinion" on any reply (whole message or a highlighted excerpt).
- **Send back** feeds the critique to the primary model for a rebuttal.
- **Toggle** which model is primary at any time.

**Bring your own key.** The app ships with no API keys. Each visitor pastes their own
Anthropic and/or OpenAI key in Settings; the key is stored in that person's browser and
sent with their own requests. Whoever deploys this never pays for anyone else's usage.
One key is enough to chat — second opinions need both.

Claude uses a warm amber accent, ChatGPT a green one. No real company logos — just circular lettermark badges (`C` / `G`).

---

## How it's built

| Path | What it is |
|------|-----------|
| `index.html` | The entire frontend — inline CSS + JS, no build step, no npm. |
| `functions/api/chat.js` | A Cloudflare Pages Function. Forwards each call to the provider using the key from the request header. Holds no keys of its own. |
| `README.md` | This file. |

**Where keys live:** in each user's own browser (`localStorage`), never on the server. Every
request carries the caller's key in an `x-provider-key` header; the Function uses it for that
one upstream call and discards it. Nothing is stored, cached, or logged — anything sampled
into a server log passes through `redact()` first. The Function reads **no** environment
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

You need [Wrangler](https://developers.cloudflare.com/workers/wrangler/) (Cloudflare's CLI). It runs the Pages Function locally so `/api/chat` works.

### 1. Install Wrangler

```bash
npm install -g wrangler
```

(Or use it without installing globally via `npx wrangler …`.)

### 2. Start the dev server

```bash
npx wrangler pages dev .
```

Wrangler prints a local URL (typically `http://localhost:8788`). Open it, click the gear icon,
and paste your own key(s) — exactly as any other visitor would. No `.dev.vars` file is needed:
the Function ignores environment variables entirely.

If you have an old `.dev.vars` from a previous version, it is now unused. Delete it.

---

## Deploy to Cloudflare Pages

### Option A — via the dashboard (Git-connected)

1. Push this project to a GitHub/GitLab repo.
2. In the Cloudflare dashboard: **Workers & Pages → Create → Pages → Connect to Git**.
3. Pick the repo. Build settings:
   - **Build command:** _(leave empty — there is no build step)_
   - **Build output directory:** `/`
4. Deploy.

### Option B — direct upload with Wrangler

```bash
npx wrangler pages deploy .
```

### ⚠️ Before deploying publicly: delete the API key environment variables

Earlier versions of this app read `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` from the Cloudflare
environment. **That is gone, and the variables must be deleted.**

1. Cloudflare dashboard → **Workers & Pages → your project → Settings → Environment variables**.
2. Delete `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` from **Production** *and* **Preview**.
3. Redeploy.

The current Function never reads them, so leaving them in place would not actually let
strangers spend your credit — but a stale secret sitting in a public project's settings is
a liability with no upside. Remove them. And if those keys were ever live on a public
deployment, revoke and reissue them in the provider dashboards.

Nothing else needs configuring: the site is static, each visitor brings their own key, and the
two models keep each other honest.

---

## Notes

- Conversation state is kept **in memory only** (v1). Refreshing the page starts a fresh conversation. No database, no `localStorage`.
- The code is heavily commented — tweak it by hand freely.
