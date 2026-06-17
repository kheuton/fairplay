# Fair Play

A personal webapp for tracking household duties split with the [Fair Play card system](https://www.fairplaylife.com/). Your Todoist account is the source of truth — this app is a smart client layered on top of it.

Clean-cyberpunk aesthetic (Marathon-inspired): square corners, 1px hairlines, technical mono microcopy, restrained accent color, background grid. Three skins: **bone**, **eclipse**, **vapor**.

---

## Quickstart

```sh
npm install
```

Add your Todoist API token (get it from https://app.todoist.com/app/settings/integrations/developer):

```sh
# option A — .env.local (gitignored)
echo 'VITE_TODOIST_API_TOKEN=your_token_here' >> .env.local

# option B — via the Settings page in the running app
npm run dev
# then go to Settings (/settings) and paste the token
```

```sh
npm run dev        # start dev server (http://localhost:5173)
npm run build      # production build
npm run preview    # serve production build locally
```

---

## Todoist data model

**Profiles** — the app supports two profiles, toggled in the top bar:

| Profile | Deck parent project | Default theme |
|---------|-------------------|--------------|
| Amy (default) | `Amy's Fair Play Cards` | eclipse |
| Kyle | `My Fair Play Cards` | vapor |

Both profiles share a single Todoist token. Switching profiles reloads the deck from the corresponding parent project and switches the theme to that profile's preference (independently adjustable in Settings).

**The deck** = child projects of the active profile's deck parent project.

Each child project is one Fair Play card. A task belongs to a card because it lives in that project. Projects outside this tree are ignored.

**Card order** comes from the Todoist `child_order` field on each project. If you add, rename, or remove card projects in Todoist, the app follows automatically at the next load.

**Card id (slug)** is derived from the project name: lowercase, every run of non-alphanumeric characters becomes a single `-`, leading/trailing dashes stripped. Example: `Bathing & grooming (kids)` → `bathing-grooming-kids`.

### Carrier tasks (app-owned state parked in Todoist)

These tasks live inside card projects but are never shown as to-dos:

| Label | Purpose |
|-------|---------|
| `FP-item` | One persistent task per inventory supply item (never completed) |
| `FP-config` | One task per card holding config, e.g. `FairPlay config - auto` for the odometer |

### FP:: metadata line

App-owned state is embedded as the **last line** of a task description:

```
FP::{compact JSON}
```

Example — an inventory item with burn-rate tracking:

```
FP::{"inv":{"icon":"tp","w":2,"h":2,"x":0,"y":0,"stack":30,"count":14,"verified":"2026-06-01","rate":{"n":0.7,"per":"day"},"warn":{"mode":"days","value":7}}}
```

The UI always shows the clean description (the `FP::` line is stripped before display). `src/lib/metadata.ts` implements `parseFp` and `withFp`.

---

## Customization

### Change a card's kind, category, or color

Edit `src/cards/deck-config.ts`. The `CARD_OVERRIDES` map is keyed by the **exact** Todoist project name. Available kinds: `timeline` | `inventory` | `auto` | `home` | `datenight`.

### Change a profile's parent project name

Edit the `deckParent` field of the relevant profile in `PROFILES` inside `src/cards/deck-config.ts`.

### Add your own house layout (Home Maintenance card)

Edit `src/cards/home/floorplan.ts` — it defines rooms, hotspots, and their coordinates as data. No image replacement needed; the card renders as a SVG schematic from the data.

---

## Theming

Three skins are available via the Settings page or by setting `theme` in the persisted settings store:

| Key | Description |
|-----|-------------|
| `bone` | Light (warm off-white ink on parchment) |
| `eclipse` | Dark (near-black with amber accents) |
| `vapor` | Dark default (deep black, coral accent) |

All colors flow through CSS custom properties (`--ink`, `--accent`, `--bg`, etc.) defined in `src/styles/theme.css`. A custom accent color can be set via Settings; it overrides `--accent` and `--accent-d` on the app root.

Density variants (`compact` | `regular` | `comfy`) adjust row heights and spacing via the `data-density` attribute on the app root.

---

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start Vite dev server with Todoist API proxy |
| `npm run build` | TypeScript check + production bundle |
| `npm run preview` | Serve the production build locally |
| `npx vitest run` | Run unit tests (metadata, inventory-math, deck resolution, format) |
| `node scripts/smoke.mjs` | Read-only integration check: resolves the real deck and prints open task counts per card |

---

## Deployment

Pushing to `main` triggers `.github/workflows/deploy.yml`, which builds the app and publishes the static SPA to GitHub Pages at **https://kheuton.github.io/fairplay/**.

- The production build talks directly to `https://api.todoist.com` from the browser (CORS is enabled on the Todoist API — no server-side proxy required).
- Each user enters their own Todoist API token in the Settings page; it is stored in `localStorage` and never sent anywhere except Todoist.
- **Never set `VITE_TODOIST_API_TOKEN` in CI or GitHub Actions secrets.** Doing so would bake your personal token into the public JavaScript bundle.

---

## Security

**Your token never leaves your machine during development.**

- Stored in `localStorage` (via the Settings page) or in `.env.local` (gitignored).
- In **development**, browser-to-Todoist API calls go through the local Vite dev server proxy (`/todoist-api` → `https://api.todoist.com`), so the token travels only over your local loopback.
- In **production** (the static build served from GitHub Pages), the app calls the Todoist API **directly** from the browser (`https://api.todoist.com`). This works because Todoist's API is CORS-enabled — no server-side proxy is needed. The token is supplied per-user via the Settings page (stored in `localStorage`). `VITE_TODOIST_API_TOKEN` must **never** be set in CI or production, as it would bake a token into the public bundle.
- The app never logs the token to the console.
- Carrier tasks (`FP-item`, `FP-config`) and metadata (`FP::`) are written to your **own** Todoist account only — no external service is involved beyond Todoist itself.
