# Boots & Gloves — Score Card

A real-time scorecard for the card game Boots & Gloves. Track books, cards, and running totals across rounds with live sync across all connected devices.

**[▶ Open the scorecard](https://pankajparag.github.io/boots-and-gloves-scorecard/)**

---

## Features

- **Three game modes** — Team 2v2, Team 3v3, Individual 3-player
- **Live sync** — Firebase Realtime Database keeps all devices in sync instantly
- **Shared fixed scorecards** — each mode has a permanent game code so everyone joins the same board automatically
- **Custom scorecards** — create a named game for a one-off session
- **Player names** — set and rename players at any time; names reflect everywhere instantly (scoreboard, entry columns, edit modal)
- **Preset name dropdown** — combobox with suggested names, accepts custom text too
- **Round editing** — click any past round to correct scores
- **Meld tracker** — shows the current meld requirement based on each player's running total
- **Auto-restore** — reloads your last active game on page refresh

---

## Game modes & scoring

| Mode | Players | Win target |
|---|---|---|
| Team 2v2 | 2 teams × 2 players | 10,000 pts |
| Team 3v3 | 2 teams × 3 players | 10,000 pts |
| Individual 3P | 3 players | 6,000 pts |

**Round scoring:**

| Item | Points |
|---|---|
| Red book | +500 |
| Black book | +300 |
| Going out bonus | +100 |
| Joker (in hand) | +50 |
| 2 or Ace (in hand) | +20 |
| K–10 (in hand) | +10 |
| 9–4 (in hand) | +5 |
| Leftover Joker | −50 |
| Leftover 2/Ace | −20 |
| Leftover K–10 | −10 |
| Leftover 9–3 and below | −5 |
| Red 3 leftover | −500 |

The player who goes out scores no leftover penalty. Meld requirements increase as your total score rises — see the meld table below the scoreboard.

---

## Running locally

No build step required.

```bash
# 1. Clone the repo
git clone https://github.com/pankajparag/boots-and-gloves-scorecard.git
cd boots-and-gloves-scorecard

# 2. Set up Firebase config
cp firebase-config.example.js firebase-config.js
# Edit firebase-config.js and replace YOUR_API_KEY_HERE with a real key

# 3. Serve
python3 -m http.server 8080
# Then open http://localhost:8080
```

> Firebase config is gitignored. You need a Firebase project with Realtime Database enabled and the database rules set to allow read/write.

---

## Deployment

Pushes to `main` auto-deploy to GitHub Pages via `.github/workflows/deploy.yml`. The workflow injects the Firebase API key from the `FIREBASE_API_KEY` repository secret before publishing — no secrets are committed to the repo.

---

## Running tests

```bash
npm test          # run once
npm run test:watch  # watch mode
```

Tests cover pure game logic (scoring, meld thresholds, winner detection) and the rename data model. They run in Node via Vitest with no browser dependency.

---

## Architecture

Vanilla JS + Firebase Realtime Database. No framework, no bundler.

```
index.html      — all markup; inline handlers call window.* functions
app.js          — game logic, rendering, Firebase sync
game-logic.js   — pure scoring logic (no DOM / Firebase; imported by tests)
style.css       — all styles
firebase-config.js  — exports the Firebase db instance (gitignored)
tests/          — Vitest unit tests
```

**State model:**

```
game = {
  mode, isTeam, target, gameId, gameCode,
  players,   // always individuals; each has entityIdx into entities[]
  entities,  // what gets scored: players (ind3) or teams (team2v2/3v3)
  rounds,    // [{ round, outPlayerIdx, breakdowns[] }]
  round,     // current round number
}
```

`players` vs `entities` is the key split: in team modes multiple players share one entity, so scoring operates on `entities` while "who went out" is tracked per `player`.

**Sync:** the entire game state is written as one JSON blob on every save. All clients subscribe via `onValue()` and re-render on change. An `isRemoteUpdate` flag suppresses the local echo from our own writes.
