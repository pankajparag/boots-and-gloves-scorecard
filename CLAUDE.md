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

Each game mode maps to a fixed Firebase path (`games/bnag-{code}/`). The entire game state is written as one JSON blob on every save and edit. All connected clients subscribe via `onValue()` and re-render on every change.

The `isRemoteUpdate` flag (`app.js:74`) prevents the write-echo loop: it's set to `true` before every `pushToFirebase()` call and reset after, so the immediate `onValue` callback from that write is silently ignored.

**Scoring flow:**

1. Each entity column has its own Save button (`commitEntity(ei)`).
2. Saves are staged in `game.submitted` + `game.pending` until all entities are saved.
3. When the last entity is saved, the round is finalized: `game.rounds` gets a new entry, `game.round` increments, `pushToFirebase()` is called, and the scoreboard re-renders.
4. Editing a past round opens a modal (`openEditModal`), which on save overwrites that round's `breakdowns` in place and re-pushes.

**Meld thresholds** (`MELD_IND` / `MELD_TEAM`) define the minimum meld required at each score bracket and are shown in the meld table below the scoreboard.
