# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running locally

No build step. Open `index.html` directly in a browser, or serve with any static file server:

```bash
python3 -m http.server 8080
```

Before opening in a browser, create `firebase-config.js` from the example and add a real Firebase API key:

```bash
cp firebase-config.example.js firebase-config.js
# Edit firebase-config.js and replace YOUR_API_KEY_HERE
```

`firebase-config.js` is gitignored. In CI, the deploy workflow injects the key via the `FIREBASE_API_KEY` GitHub secret using `sed`.

## Deployment

Pushes to `main` auto-deploy to GitHub Pages via `.github/workflows/deploy.yml`. The workflow injects the Firebase API key into `firebase-config.js` before publishing.

## Architecture

This is a vanilla JS + Firebase Realtime Database app with no build tooling. All Firebase SDK imports come directly from the `gstatic.com` CDN as ES modules.

**Files:**
- `index.html` — all markup; exposes `onModeChange`, `startGame`, `commitEntity`, etc. as `window.*` functions called by inline handlers
- `app.js` — all game logic, rendering, and Firebase sync
- `style.css` — all styles
- `firebase-config.js` — exports `db` (the Firebase Realtime Database instance); gitignored

**Game state (`game` object in `app.js`):**

```
game = {
  mode, isTeam, target, gameId, gameCode,
  players,   // always individuals, each has entityIdx pointing into entities[]
  entities,  // what gets scored: individual players (ind3) or teams (team2v2, team3v3)
  rounds,    // array of { round, outPlayerIdx, breakdowns[] }
  round,     // current round number
  submitted, // entity indices saved this round (transient, not pushed to Firebase)
  pending    // entity breakdowns awaiting final round commit (transient)
}
```

`players` vs `entities` is the key distinction: in team modes, multiple players share one entity (team), so scoring operates on `entities` while "who went out" is tracked per `player`.

**Firebase sync pattern:**

Two Firebase paths are used:

- `games/bnag-{code}/` — finalized game state (rounds, scores, players). Written once per round when all entities commit.
- `drafts/bnag-{code}/{ei}` — live in-progress scores per entity. Written on every keystroke (debounced 400 ms) and cleared when a round finalizes.

All connected clients subscribe to both paths via `onValue()`. The `isRemoteUpdate` flag prevents the write-echo loop on the main game path.

**Scoring flow (multi-device):**

1. Each entity column has its own Save button (`commitEntity(ei)`).
2. As scores are typed, `scheduleDraftPush(ei)` debounces a write to `drafts/.../ei` so all devices see live values.
3. Clicking Save pushes a `committed: true` draft and marks the column disabled locally; other devices see the column lock immediately.
4. When all entity drafts are `committed`, any client that detects this calls `finalizeRound()`: breakdowns are built from draft data, `game.rounds` gets a new entry, `game.round` increments, drafts are cleared, and the main game state is pushed.
5. Editing a past round opens a modal (`openEditModal`), which on save overwrites that round's `breakdowns` in place and re-pushes.

**Firebase rules requirement:**

The `drafts/` path must be readable and writable. Add this alongside the `games` rule in the Firebase Console → Realtime Database → Rules:

```json
"drafts": { ".read": true, ".write": true }
```

**Meld thresholds** (`MELD_IND` / `MELD_TEAM`) define the minimum meld required at each score bracket and are shown in the meld table below the scoreboard.

## Testing

### Unit tests (Vitest)

```bash
npm test
```

Tests live in `tests/`. Only `*.test.js` files are picked up (Vitest is scoped via `vitest.config.js`).

### E2E tests (Playwright)

Requires `firebase-config.js` to exist with a valid API key, and the Firebase rules above to be in place.

```bash
npm run test:e2e
```

Tests live in `e2e/`. Playwright auto-starts the Python file server. Two test files:
- `e2e/ui.spec.js` — page load, game start, score entry UI
- `e2e/sync.spec.js` — multi-device live draft sync, save propagation, round finalization

The sync tests open two independent browser contexts (simulating two devices) and verify the full live-scoring flow end to end. They auto-skip with a clear message if the Firebase `drafts/` rules are not configured.
