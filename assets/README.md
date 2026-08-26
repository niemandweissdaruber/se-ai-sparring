# Logo assets

Drop the two provider logo files in here:

| File | Shown for | Alt text |
|------|-----------|----------|
| `claude.webp` | Claude / Anthropic | `Claude` |
| `openai.png` | ChatGPT / OpenAI | `ChatGPT` |

They are rendered inside the circular badge at ~66% of its size, unmodified —
no recolouring, rotation, or filters. Square (1:1) artwork sits best.

If a file is missing or fails to load, the app falls back automatically to the
`C` / `G` lettermark, so it is never broken — it just looks like it did before.

## Badge backgrounds

The disc behind each logo is set per model in `index.html`, because the two
marks need opposite grounds:

| Variable | Default | Why |
|----------|---------|-----|
| `--logo-bg-claude` | `#1d2029` (dark) | The orange Claude mark reads on dark. |
| `--logo-bg-chatgpt` | `#f5f5f7` (near-white) | The OpenAI mark is black and would vanish on dark. |

The amber/green accents stay on the badge ring and glow — never on the artwork
itself. If you swap in differently-coloured artwork, change the matching
variable and nothing else.

## Changing the filenames

Paths live in one place: the `LOGO_SRC` constant in `index.html`.
