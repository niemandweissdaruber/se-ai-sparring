# Logo assets

Drop the two provider logo files in `public/assets/` (this file is
documentation and is deliberately not served):

| File | Shown for | Alt text |
|------|-----------|----------|
| `public/assets/claude.webp` | Claude / Anthropic | `Claude` |
| `public/assets/openai.png` | ChatGPT / OpenAI | `ChatGPT` |

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

## SE Ranking mark

`SE_Ranking_sign_blue_830e39b207.webp` in this folder is the source artwork for
the SE Ranking icon on the "SE Ranking data" toggle. It is kept here for
provenance only and is **not served** — the icon ships inlined as a base64 data
URI in `public/index.html`, so there is no asset request and nothing to 404.

Note the file is actually a PNG despite the `.webp` extension (that is how it
was supplied). To regenerate the data URI after replacing it:

```bash
sips -Z 72 assets/SE_Ranking_sign_blue_830e39b207.webp --out /tmp/mark.png
python3 -c "import base64;print('data:image/png;base64,'+base64.b64encode(open('/tmp/mark.png','rb').read()).decode())"
```

Downscaling first matters: the 520×568 original is 5.7 KB, which becomes ~7.6 KB
of base64; at 72px it is ~2.1 KB, and it renders at 17px.
