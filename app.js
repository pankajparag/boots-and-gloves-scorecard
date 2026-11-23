import { db } from "./firebase-config.js";
import {
  ref, set, onValue, get, goOffline, goOnline
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import {
  getBrackets, getMeld, getBracketIndex, isTeamMode, calcTotal, checkWinner, buildGame,
  canFinalize, allCommitted, hasExactlyOneWentOut, computeFinalOutPi, buildBreakdownsFromDrafts,
  getForehandPlayerIdx
} from "./game-logic.js";

// ── Firebase paths ────────────────────────────────────────────────────────────
const FIXED_GAME_IDS = {
  ind3:    { id: "bnag-dferem",  code: "dferem"  },
  team2v2: { id: "bnag-utv8e9",  code: "utv8e9"  },
  team3v3: { id: "bnag-xv2w4e",  code: "xv2w4e"  }
};

const PRESET_NAMES = ["Marvin","Sandra","Becky","Pankaj","Juan","Laurie","Frances","Abhishek","Gaurav"];

// ── game state ────────────────────────────────────────────────────────────────
let game = null;
let currentGameId = null;
let currentGameCode = null;
let syncUnsubscribe = null;
let draftsUnsubscribe = null;
let isRemoteUpdate = false;
let isFinalizingRound = false;
let renameTimer = null;
let draftTimers = {};    // ei → debounce timer for live draft push
let localEditTime = {};  // ei → timestamp of last local keystroke
let localOutTime = 0;    // timestamp of last local "who went out" checkbox change
let currentDrafts = {};  // latest snapshot from drafts/{id} in Firebase
let boardSeq = 0;          // bumped whenever the board being watched changes
let boardId = null;        // game path the board on screen belongs to (and listens to)
let syncDropdownOnLoad = true; // false once the user picks "custom" while a board is loading
let isConnected = false;   // from .info/connected
let statusState = "syncing";
let reconnectEpoch = 0;    // bumped on each forced reconnect
let reconnectTimer = null;
let hiddenAt = 0;

// A "score field" is any count input in the live entry columns or the round-edit
// modal — the set the Enter-to-advance behavior below applies to.
function isScoreField(el) {
  return el instanceof HTMLInputElement && el.type === "number" &&
    el.closest(".score-cols, .modal-field");
}

// A "live" score field is a score field in the current round's entry columns,
// as opposed to the edit modal, whose fields already hold real saved data
// from a past round rather than a fresh default — see the focusin listener below.
function isLiveScoreField(el) {
  return el instanceof HTMLInputElement && el.type === "number" && el.closest(".score-cols");
}

// ── Enter-to-advance ──────────────────────────────────────────────────────────
// Numeric keypads have no Tab key, so Enter mimics Tab: move focus to the next
// score field instead of doing nothing (number inputs have no form to submit).
document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || !isScoreField(e.target)) return;
  const target = e.target;
  // Scope to whichever grid the field belongs to — the edit modal overlays
  // the main entry columns without removing them from the DOM, so a global
  // query would splice the two separate field sequences together.
  const scope = target.closest(".modal, #entry-columns");
  if (!scope) return;
  e.preventDefault();
  const fields = Array.from(scope.querySelectorAll("input[type=number]"))
    .filter(el => !el.disabled && el.offsetParent !== null);
  const idx = fields.indexOf(target);
  if (idx === -1) return;
  const next = fields[(idx + 1) % fields.length];
  next.focus();
  next.select();
});

// Select-all-on-focus: live entry fields default to "0", so without this the first
// keystroke lands next to the existing digit instead of replacing it (e.g.
// typing "2" yields "02" or "20" depending on cursor position). Scoped to the
// live scoreboard only — edit-modal fields already hold real saved data, and
// selecting it all on focus would wipe a correct value on the first keystroke
// when the user only meant to nudge one wrong count.
document.addEventListener("focusin", (e) => {
  if (isLiveScoreField(e.target)) e.target.select();
});

// ── Firebase sync ─────────────────────────────────────────────────────────────
function gameRef(id)   { return ref(db, "games/"  + (id || currentGameId)); }
function draftsRef(id) { return ref(db, "drafts/" + (id || currentGameId)); }

// JSON with sorted keys and null/undefined dropped, matching how Firebase stores
// data, so a local object and its round-tripped snapshot compare equal.
function stableJson(v) {
  if (Array.isArray(v)) return "[" + v.map(stableJson).join(",") + "]";
  if (v && typeof v === "object") {
    return "{" + Object.keys(v).sort().filter(k => v[k] != null)
      .map(k => JSON.stringify(k) + ":" + stableJson(v[k])).join(",") + "}";
  }
  return JSON.stringify(v);
}

// The part of `game` stored in Firebase (submitted/pending are per-device).
function gamePayload(g) {
  const { mode, isTeam, target, gameId, gameCode, players, entities, rounds, round } = g;
  return { mode, isTeam, target, gameId, gameCode, players, entities, rounds, round };
}

async function pushToFirebase() {
  if (!currentGameId) return;
  const payload = gamePayload(game);
  try {
    setStatus("syncing");
    await set(gameRef(), payload);
    setStatus("synced");
  } catch (e) {
    setStatus("error");
    console.error("Firebase write error:", e);
  }
}

// Listen to a game. With `loading` set, the first snapshot is the load result:
// it puts the board on screen (and lines the dropdown up with it). A fresh
// listener always gets its first snapshot from the server, never a stale cache.
function subscribeToFirebase(gameId, loading = false) {
  if (syncUnsubscribe) { syncUnsubscribe(); syncUnsubscribe = null; }
  boardId = gameId;
  subscribeToDrafts(gameId);
  let first = loading;
  syncUnsubscribe = onValue(gameRef(gameId), snapshot => {
    if (isRemoteUpdate && !first) return;  // echo of our own write
    const data = snapshot.val();
    if (first) {
      first = false;
      displayGame(gameId, data, syncDropdownOnLoad);
      setStatus("synced");
      return;
    }
    setStatus("synced");
    // Game deleted / not started: show the empty state but keep listening, so a
    // game started on another device appears here without a reload.
    if (!data) { if (game) showNoGame(); return; }
    // New game, reset, or new round: redraw from scratch (resets this device's
    // saved-column state and the winner banner / entry area).
    if (!game || data.round !== game.round || (data.gameId || gameId) !== game.gameId) {
      currentDrafts = {};
      showGame(data, gameId);
      return;
    }
    // Same round (rename, past-round edit): keep this device's saved columns.
    const next = normalizeGame(data, game.submitted, game.pending);
    // Nothing changed (e.g. the server echoing what's already shown): don't
    // redraw — that would wipe score inputs typed but not yet sent as drafts.
    if (stableJson(gamePayload(next)) === stableJson(gamePayload(game))) return;
    game = next;
    currentGameId   = data.gameId   || gameId;
    currentGameCode = data.gameCode || "";
    updateGameCodeDisplay();
    renderAll();
    renderPlayersBar();
  }, err => {
    setStatus("error");
    console.error("Firebase subscribe error:", err);
  });
}

// ── draft sync (live per-keystroke Firebase updates) ──────────────────────────
function subscribeToDrafts(gameId) {
  if (draftsUnsubscribe) { draftsUnsubscribe(); draftsUnsubscribe = null; }
  draftsUnsubscribe = onValue(ref(db, "drafts/" + gameId), snapshot => {
    currentDrafts = snapshot.val() || {};
    if (!game) return;
    const entryArea = document.getElementById("entry-area");
    if (entryArea && entryArea.style.display !== "none") applyDraftsToUI(currentDrafts);
    renderScoreboard();
    updateFinalizeWarning(currentDrafts);
    if (shouldFinalize(currentDrafts) && !isFinalizingRound) {
      isFinalizingRound = true;
      finalizeRound(currentDrafts).catch(e => { console.error(e); isFinalizingRound = false; });
    }
  });
}

async function pushDraft(ei, committed = false) {
  if (!currentGameId || !game) return;
  const b = readBreakdownFromDOM(ei);
  const outPi = getOutPlayerIdx();
  try {
    await set(ref(db, "drafts/" + currentGameId + "/" + ei), { ...b, outPi, committed, round: game.round });
  } catch (e) { console.error("Draft push error:", e); }
}

function scheduleDraftPush(ei) {
  localEditTime[ei] = Date.now();
  clearTimeout(draftTimers[ei]);
  draftTimers[ei] = setTimeout(() => {
    draftTimers[ei] = null;
    if (game && !game.submitted.includes(ei)) pushDraft(ei, false);
  }, 400);
}

const DRAFT_FIELDS = ['rb','bb','pjoker','pwild','pface','plow','nred3','njoker','nwild','nface','nlow'];

function applyDraftsToUI(drafts) {
  if (!game) return;
  game.entities.forEach((e, ei) => {
    const draft = drafts[ei];
    if (!draft || draft.round !== game.round) return;
    const col = document.getElementById(`col-${ei}`);
    if (!col) return;

    // Only apply values if user hasn't typed in this column in the last 2 s
    if (!localEditTime[ei] || Date.now() - localEditTime[ei] >= 2000) {
      DRAFT_FIELDS.forEach(f => {
        const inp = document.getElementById(`${f}-${ei}`);
        if (inp) inp.value = draft[f] ?? 0;
      });
      updateColPreview(ei);
    }

    // Live "entering…" badge in the column header
    const headerEl = col.querySelector('.entity-col-header');
    if (headerEl) {
      let badge = col.querySelector('.draft-badge');
      if (!draft.committed) {
        if (!badge) { badge = document.createElement('div'); badge.className = 'draft-badge'; headerEl.appendChild(badge); }
        badge.textContent = '✏ entering…';
      } else if (badge) {
        badge.remove();
      }
    }

    // Mark column as saved when remote commit arrives
    if (draft.committed && !game.submitted.includes(ei)) {
      game.submitted.push(ei);
      markEntitySaved(ei);
    }
  });

  // Sync "who went out" from remote drafts if the user hasn't touched it locally in the last 2 s
  let remoteOutPi = -1;
  let hasDraft = false;
  Object.keys(drafts).forEach(eiStr => {
    const d = drafts[eiStr];
    if (d && d.round === game.round) { hasDraft = true; if (d.outPi >= 0) remoteOutPi = d.outPi; }
  });
  if (hasDraft && remoteOutPi !== getOutPlayerIdx() && Date.now() - localOutTime >= 2000) {
    applyOutPiToUI(remoteOutPi);
  }

  // If any committed draft has a player going out, lock "who went out" for all other entities
  let wentOutEntityIdx = -1;
  Object.keys(drafts).forEach(eiStr => {
    const d = drafts[eiStr];
    if (d && d.committed && d.outPi >= 0 && d.round === game.round) {
      const p = game.players[d.outPi];
      if (p) wentOutEntityIdx = p.entityIdx;
    }
  });
  if (wentOutEntityIdx >= 0) disableWentOutForOthers(wentOutEntityIdx);
}

function markEntitySaved(ei) {
  const col = document.getElementById(`col-${ei}`);
  if (!col) return;
  // Restore the actual submitted values from current drafts (if available) before disabling
  const draft = currentDrafts[ei];
  if (draft) {
    DRAFT_FIELDS.forEach(f => { const inp = document.getElementById(`${f}-${ei}`); if (inp) inp.value = draft[f] ?? 0; });
  }
  col.classList.add("col-saved");
  const btn = col.querySelector(".btn-success");
  if (btn) { btn.className = "btn btn-saved"; btn.disabled = true; btn.textContent = `✓ Saved — ${game.entities[ei].name}`; }
  DRAFT_FIELDS.forEach(f => { const inp = document.getElementById(`${f}-${ei}`); if (inp) inp.disabled = true; });
  // "Went out" checkboxes stay enabled after save (unless disableWentOutForOthers
  // locks them once a winner is confirmed) — otherwise an entity saved before
  // anyone is marked as going out would freeze its draft's outPi at -1 forever,
  // deadlocking canFinalize's hasExactlyOneWentOut check.
  updateColPreview(ei);
}

function shouldFinalize(drafts) {
  if (!game) return false;
  return canFinalize(drafts, game.round, game.entities.length);
}

// Surfaces a banner once every entity has saved but no single player is
// recorded as having gone out yet, so the round doesn't stall silently.
function updateFinalizeWarning(drafts) {
  const el = document.getElementById("finalize-warning");
  if (!el || !game) return;
  const stuck = allCommitted(drafts, game.round, game.entities.length)
    && !hasExactlyOneWentOut(drafts, game.entities.length);
  el.style.display = stuck ? "" : "none";
}

async function finalizeRound(drafts) {
  if (!game || !currentGameId) return;
  const finalOutPi  = computeFinalOutPi(drafts, game.entities.length);
  const breakdowns  = buildBreakdownsFromDrafts(drafts, game.entities, game.players, game.isTeam, finalOutPi);

  game.rounds.push({ round: game.round, outPlayerIdx: finalOutPi, breakdowns });
  game.round++;
  game.submitted = [];
  game.pending   = {};
  localEditTime  = {};
  localOutTime   = 0;
  currentDrafts  = {};

  // Pin the game being finalized: the user may switch boards during the awaits.
  const id = currentGameId, g = game;
  try {
    await set(draftsRef(id), null);
    isRemoteUpdate = true;
    try {
      setStatus("syncing");
      await set(gameRef(id), gamePayload(g));
      setStatus("synced");
    } catch (e) {
      setStatus("error");
      console.error("Firebase write error:", e);
    } finally {
      isRemoteUpdate = false;
    }
    if (game !== g) return;  // a different board is on screen now
    renderBoard();
    window.scrollTo(0, 0);
  } finally {
    isFinalizingRound = false;
  }
}

// Remembers the last operation's result; the badge shows it, except that
// "connecting…" overrides a healthy state while the socket is down.
function setStatus(state) {
  if (state) statusState = state;
  state = statusState;
  const el = document.getElementById("sync-status");
  if (!el) return;
  if (state !== "error" && !isConnected) state = "offline";
  const s = {
    synced:  { text: "● synced",     color: "#1a6b3a" },
    syncing: { text: "○ syncing…",   color: "#9a7410" },
    error:   { text: "✕ sync error", color: "#c0392b" },
  }[state] || { text: "◌ connecting…", color: "#6b6b80" };
  el.textContent = s.text;
  el.style.color = s.color;
}

function updateGameCodeDisplay() {
  const el    = document.getElementById("game-code-display");
  const badge = document.getElementById("game-badge");
  if (el && currentGameCode) {
    el.textContent = currentGameCode;
    if (badge) badge.style.display = "block";
  } else if (badge) {
    badge.style.display = "none";
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
// Small colored dot identifying an entity — reused on the scoreboard header,
// entry column headers, and the meld table so the same color always means
// the same entity across the page.
function entityDotHtml(ei, name) {
  return `<span class="entity-dot entity-dot-${ei}" title="${esc(name)}"></span>`;
}
function toArray(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v;
  return Object.keys(v).sort((a, b) => Number(a) - Number(b)).map(k => v[k]);
}
function num(id)  { const el = document.getElementById(id); return el ? (parseInt(el.value) || 0) : 0; }
function chk(id)  { const el = document.getElementById(id); return el ? el.checked : false; }
function getTotals() {
  if (!game) return [];
  const t = game.entities.map(() => 0);
  for (const r of game.rounds) r.breakdowns.forEach((b, i) => t[i] += b.total);
  return t;
}
function gridStyle(n) { return `grid-template-columns:96px repeat(${n},1fr)`; }
function getOutPlayerIdx() {
  for (let i = 0; i < game.players.length; i++) if (chk(`out-${i}`)) return i;
  return -1;
}
function disableWentOutForOthers(outEntityIdx) {
  if (!game) return;
  game.players.forEach((p, pi) => {
    if (p.entityIdx !== outEntityIdx) {
      const el = document.getElementById(`out-${pi}`);
      if (el) { el.disabled = true; el.checked = false; }
    }
  });
  game.entities.forEach((_, ei) => {
    if (ei !== outEntityIdx) {
      const section = document.getElementById(`col-${ei}`)?.querySelector('.went-out-section');
      if (section) section.classList.add('went-out-inactive');
    }
  });
}
function findPlayerByPosition(ei, posInTeam) {
  let count = 0;
  for (let pi = 0; pi < game.players.length; pi++) {
    if (game.players[pi].entityIdx === ei) {
      if (count === posInTeam) return pi;
      count++;
    }
  }
  return -1;
}

function getDealerInfo(roundNum) {
  if (!game) return null;
  const totalPlayers = game.players.length;
  const dealerIdx = (roundNum - 1) % totalPlayers;
  if (game.isTeam) {
    const numTeams = game.entities.length;
    const teamIdx = dealerIdx % numTeams;
    const posInTeam = Math.floor(dealerIdx / numTeams);
    const pi = findPlayerByPosition(teamIdx, posInTeam);
    return pi >= 0 ? { entityIdx: teamIdx, playerName: game.players[pi].name } : null;
  } else {
    // ind3: each player is their own entity
    return { entityIdx: dealerIdx, playerName: game.players[dealerIdx].name };
  }
}

// Who opens (leads) the round — the first player at game start, then
// whoever went out last. Unlike the dealer this can't be predicted ahead of
// the current round, since it depends on an outcome that hasn't happened yet.
function getForehandInfo(roundNum) {
  if (!game) return null;
  const pi = getForehandPlayerIdx(roundNum, game.rounds);
  const p = game.players[pi];
  return p ? { entityIdx: p.entityIdx, playerName: p.name } : null;
}

// Default names for a fresh game. User renames via the players bar.
function defaultPlayerNames(mode) {
  return ({
    ind3:    { P1:"Player 1", P2:"Player 2", P3:"Player 3" },
    team2v2: { T1P1:"T1-P1", T1P2:"T1-P2", T2P1:"T2-P1", T2P2:"T2-P2" },
    team3v3: { T1P1:"T1-P1", T1P2:"T1-P2", T1P3:"T1-P3", T2P1:"T2-P1", T2P2:"T2-P2", T2P3:"T2-P3" }
  })[mode] || {};
}

// ── setup UI ──────────────────────────────────────────────────────────────────
window.onModeChange = async function() {
  const mode = document.getElementById("game-mode").value;
  const isCustom = mode === "custom";
  const effectiveMode = isCustom ? document.getElementById("custom-mode").value : mode;
  document.getElementById("win-target").value = isTeamMode(effectiveMode) ? 10000 : 6000;
  document.getElementById("custom-game-row").style.display = isCustom ? "flex" : "none";
  highlightActiveLink(mode);
  if (isCustom) {
    // The current board stays on screen and live until Start; a board still
    // loading must not flip the dropdown away from what the user is setting up.
    syncDropdownOnLoad = false;
    return;
  }
  const fixed = FIXED_GAME_IDS[mode];
  if (fixed) loadGame(fixed.id);
};

window.onCustomModeChange = function() {
  const sub = document.getElementById("custom-mode").value;
  document.getElementById("win-target").value = isTeamMode(sub) ? 10000 : 6000;
};

function highlightActiveLink(mode) {
  document.querySelectorAll(".game-link").forEach(a => a.classList.remove("active"));
  const fixed = FIXED_GAME_IDS[mode];
  if (fixed) {
    const el = document.getElementById("link-" + mode);
    if (el) el.classList.add("active");
  }
}

window.startGame = async function() {
  const modeSelect    = document.getElementById("game-mode").value;
  const isCustom      = modeSelect === "custom";
  const effectiveMode = isCustom ? document.getElementById("custom-mode").value : modeSelect;
  const target        = parseInt(document.getElementById("win-target").value) || 10000;

  let gameId, gameCode;
  if (isCustom) {
    const raw = (document.getElementById("custom-game-id").value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!raw || raw.length < 3) {
      alert("Please enter a custom game name (letters and numbers, at least 3 characters).");
      return;
    }
    gameCode = raw;
    gameId   = "bnag-" + raw;
  } else {
    const fixed = FIXED_GAME_IDS[modeSelect];
    gameId   = fixed.id;
    gameCode = fixed.code;
  }

  const seq = ++boardSeq;
  const stillCurrent = () => seq === boardSeq;  // false if the user switched boards meanwhile
  setStatus("syncing");

  // Read fresh: a stale cached "no game here" would let us silently overwrite
  // a game another device started.
  let snapshot;
  try {
    snapshot = await fetchFresh(gameId);
  } catch (e) {
    if (!stillCurrent()) return;
    setStatus("error");
    alert("Could not connect to Firebase. Check your connection.");
    return;
  }
  if (!stillCurrent()) return;

  if (snapshot.exists()) {
    const existing = snapshot.val();
    const resume = window.confirm(
      `A game "${gameCode}" already exists (Round ${existing.round}, players: ${toArray(existing.players).map(p => p.name).join(", ")}).\n\nCancel = resume existing · OK = start fresh`
    );
    if (!resume) {
      watchBoard(gameId, existing);
      return;
    }
  }

  flushPendingWrites();
  const fresh = buildGame(effectiveMode, target, defaultPlayerNames(effectiveMode), gameId, gameCode);
  // Clear stale drafts from any previous game at this path before writing fresh state.
  // Silently ignore permission errors — if the Firebase rules don't yet include
  // the drafts path the game start should still succeed.
  try { await set(draftsRef(gameId), null); } catch (_) {}
  if (!stillCurrent()) return;
  try {
    await set(gameRef(gameId), gamePayload(fresh));
  } catch (e) {
    if (!stillCurrent()) return;
    setStatus("error");
    console.error("Firebase write error:", e);
    alert("Could not start the game. Check your connection.");
    return;
  }
  if (!stillCurrent()) return;
  watchBoard(gameId, fresh);
};

// ── players bar ───────────────────────────────────────────────────────────────
// Single source of truth for all name editing — shown as soon as a game is active.
// Uses <input type="text" list="preset-names"> which acts as a combobox:
//   dropdown of preset names AND free-text custom names.
function renderPlayersBar() {
  const bar = document.getElementById("players-bar");
  if (!bar) return;
  if (!game) { bar.style.display = "none"; return; }
  bar.style.display = "block";

  // Exclude already-used names from the preset dropdown
  const used = new Set(game.players.map(p => p.name));
  const dl = document.getElementById("preset-names");
  if (dl) dl.innerHTML = PRESET_NAMES.filter(n => !used.has(n)).map(n => `<option value="${n}">`).join("");

  const currentDealer   = getDealerInfo(game.round);
  const nextDealer      = getDealerInfo(game.round + 1);
  const currentForehand = getForehandInfo(game.round);
  const dealerBlockHtml = `<div id="pbar-dealer-block" class="pbar-dealer-block">
    <div class="pbar-dealer-round" id="pbar-dealer-round">Round ${game.round}</div>
    <div class="pbar-role-row">
      ${currentDealer    ? `<div class="pbar-dealer-current" title="Dealing">🃏 <strong>${esc(currentDealer.playerName)}</strong></div>` : ""}
      ${currentForehand  ? `<div class="pbar-forehand-current" title="Opens the round">▶️ <strong>${esc(currentForehand.playerName)}</strong></div>` : ""}
    </div>
    ${nextDealer    ? `<div class="pbar-dealer-next">Next deal: <strong>${esc(nextDealer.playerName)}</strong></div>` : ""}
  </div>`;

  if (game.isTeam) {
    bar.innerHTML = `<div class="pbar-inner">${
      game.entities.map((e, ei) => {
        const myPlayers = game.players.map((p, pi) => ({...p, pi})).filter(p => p.entityIdx === ei);
        return `<div class="pbar-team">
          <input class="pbar-entity-input" type="text" value="${esc(e.name)}"
            placeholder="Team name" title="Team name"
            oninput="onEntityNameInput(${ei}, this)">
          <div class="pbar-players">${
            myPlayers.map(p =>
              `<input class="pbar-player-input" type="text" list="preset-names"
                value="${esc(p.name)}" placeholder="${esc(p.name)}"
                oninput="onPlayerNameInput(${p.pi}, this)">`
            ).join("")
          }</div>
        </div>`;
      }).join(`<div class="pbar-vs">vs</div>`)
    }${dealerBlockHtml}</div>`;
  } else {
    // ind3: entity name = player name, one input per player
    bar.innerHTML = `<div class="pbar-inner">${
      game.players.map((p, pi) =>
        `<input class="pbar-player-input" type="text" list="preset-names"
          value="${esc(p.name)}" placeholder="${esc(p.name)}"
          oninput="onPlayerNameInput(${pi}, this)">`
      ).join("")
    }${dealerBlockHtml}</div>`;
  }
}

// Debounced Firebase push — called after every keystroke so local state is instant
// but Firebase writes are batched.
function scheduleRenameSync() {
  clearTimeout(renameTimer);
  renameTimer = setTimeout(async () => {
    renameTimer = null;
    if (!game) return;
    isRemoteUpdate = true;
    await pushToFirebase();
    isRemoteUpdate = false;
  }, 600);
}

// Called when a team-name input changes (the entity label, e.g. "Team 1" → "Sharks")
window.onEntityNameInput = function(ei, el) {
  if (!game) return;
  game.entities[ei].name = el.value;
  if (!game.isTeam) game.players[ei].name = el.value; // ind3: entity = player
  patchEntryColumnHeaders();
  patchOpenModal();
  renderScoreboard();
  scheduleRenameSync();
};

// Called when an individual player-name input changes
window.onPlayerNameInput = function(pi, el) {
  if (!game) return;
  game.players[pi].name = el.value;
  const ei = game.players[pi].entityIdx;
  if (game.entities[ei].players) {
    // Rebuild entity's player list in-place so it always mirrors game.players
    game.entities[ei].players = game.players
      .filter(p => p.entityIdx === ei)
      .map(p => p.name);
  } else {
    // ind3: entity name = player name
    game.entities[ei].name = el.value;
  }
  patchEntryColumnHeaders();
  patchOpenModal();
  renderScoreboard();
  scheduleRenameSync();
};

// Patch entity titles and "went out" labels inside the edit modal if it is open.
function patchOpenModal() {
  if (editingRoundIdx === null || !game) return;
  game.entities.forEach((e, ei) => {
    const titleEl = document.getElementById(`modal-entity-title-${ei}`);
    if (titleEl) {
      titleEl.innerHTML = esc(e.name) + (e.players
        ? "<br><span style='font-size:.65rem;opacity:.7'>" + e.players.map(esc).join(" · ") + "</span>"
        : "");
    }
  });
  game.players.forEach((p, pi) => {
    const label = document.querySelector(`label[for="medit-out-${pi}"]`);
    if (label) label.textContent = p.name + " went out";
  });
}

// Patch entry column headers and labels after a name change without resetting score inputs.
function patchEntryColumnHeaders() {
  if (!game) return;
  const dealer   = getDealerInfo(game.round);
  const forehand = getForehandInfo(game.round);
  game.entities.forEach((e, ei) => {
    const col = document.getElementById(`col-${ei}`);
    if (!col) return;
    const colName = col.querySelector('.col-name');
    if (colName) colName.textContent = e.name;
    const colPlayers = col.querySelector('.col-players');
    if (colPlayers) colPlayers.textContent = (e.players || []).join(' · ');
    game.players.forEach((p, pi) => {
      if (p.entityIdx !== ei) return;
      const label = col.querySelector(`label[for="out-${pi}"]`);
      if (label) label.textContent = p.name;
    });
    const saveBtn = col.querySelector('.btn-success, .btn-saved');
    if (saveBtn) {
      const saved = saveBtn.classList.contains('btn-saved');
      saveBtn.textContent = `✓ ${saved ? 'Saved' : 'Save'} — ${e.name}`;
    }
    const dealerEl = col.querySelector('.dealer-badge');
    if (dealerEl && dealer && dealer.entityIdx === ei) {
      dealerEl.textContent = `🃏 Dealing: ${dealer.playerName}`;
    }
    const forehandEl = col.querySelector('.forehand-badge');
    if (forehandEl && forehand && forehand.entityIdx === ei) {
      forehandEl.textContent = `▶️ Opens: ${forehand.playerName}`;
    }
  });
  const dealerBlock = document.getElementById("pbar-dealer-block");
  if (dealerBlock) {
    const roundEl = document.getElementById("pbar-dealer-round");
    if (roundEl) roundEl.textContent = `Round ${game.round}`;
    const currentDealer   = getDealerInfo(game.round);
    const nextDealer      = getDealerInfo(game.round + 1);
    const currentForehand = getForehandInfo(game.round);
    const currentEl = dealerBlock.querySelector(".pbar-dealer-current strong");
    if (currentEl && currentDealer) currentEl.textContent = currentDealer.playerName;
    const nextEl = dealerBlock.querySelector(".pbar-dealer-next strong");
    if (nextEl && nextDealer) nextEl.textContent = nextDealer.playerName;
    const forehandEl = dealerBlock.querySelector(".pbar-forehand-current strong");
    if (forehandEl && currentForehand) forehandEl.textContent = currentForehand.playerName;
  }
}

// ── scoreboard ────────────────────────────────────────────────────────────────
function renderScoreboard() {
  const { entities, rounds, isTeam } = game;
  const n = entities.length;

  const headerCells = entities.map((e, ei) => {
    const playerHtml = e.players
      ? `<br><span class="entity-player-names">${e.players.map(esc).join(' / ')}</span>`
      : "";
    return `<div style="text-align:right">${entityDotHtml(ei, e.name)} <span class="entity-display-name">${esc(e.name)}</span>${playerHtml}</div>`;
  }).join("");

  let html = `<div class="scoreboard-header" style="${gridStyle(n)}">
    <div>Round</div>${headerCells}
  </div>`;

  if (!rounds.length && !hasDraftRow()) {
    html += `<div class="empty-state"><div class="big">No rounds yet</div>Enter round 1 below</div>`;
  } else {
    const totals = entities.map(() => 0);
    for (const r of rounds) {
      r.breakdowns.forEach((b, i) => totals[i] += b.total);
      html += `<div class="score-row editable-row" style="${gridStyle(n)}" onclick="openEditModal(${r.round - 1})" title="Click to edit">
        <div class="round-label">Round ${r.round} <span style="font-size:.6rem;color:var(--gold-dark)">✎</span></div>
        ${r.breakdowns.map(b => `<div class="score-val ${b.total < 0 ? "negative" : ""}">${b.total >= 0 ? "+" : ""}${b.total}</div>`).join("")}
      </div>`;
    }
    html += renderDraftRow(entities, isTeam);
    const winner = checkWinner(totals, game.target);
    html += `<div class="score-row totals-row" style="${gridStyle(n)}">
      <div class="round-label" style="font-weight:500">Total</div>
      ${totals.map((t, i) => `<div class="score-val total ${t < 0 ? "negative" : "positive"} ${winner === i ? "winner-col" : ""}">${t.toLocaleString()}</div>`).join("")}
    </div>
    <div class="score-row meld-row" style="${gridStyle(n)}">
      <div class="round-label">Meld</div>
      ${totals.map(t => { const m = getMeld(t, isTeam); return `<div style="text-align:right"><span class="meld-badge">${m !== null ? "≥ " + m : "🏆 win"}</span></div>`; }).join("")}
    </div>`;
  }
  document.getElementById("scoreboard").innerHTML = html;
}

// True when at least one entity has an in-progress (uncommitted or committed
// but not yet finalized) draft for the current round, so the scoreboard can
// surface a live "(draft)" row before finalizeRound() commits it.
function hasDraftRow() {
  if (!game) return false;
  return game.entities.some((_, ei) => currentDrafts[ei] && currentDrafts[ei].round === game.round);
}

function renderDraftRow(entities, isTeam) {
  if (!hasDraftRow()) return "";
  const n = entities.length;
  const finalOutPi = computeFinalOutPi(currentDrafts, n);
  const breakdowns = buildBreakdownsFromDrafts(currentDrafts, entities, game.players, isTeam, finalOutPi);
  const cells = entities.map((_, ei) => {
    const d = currentDrafts[ei];
    if (!d || d.round !== game.round) return `<div class="score-val draft-val-pending">—</div>`;
    const b = breakdowns[ei];
    return `<div class="score-val draft-val ${b.total < 0 ? "negative" : ""} ${d.committed ? "" : "draft-val-live"}">${b.total >= 0 ? "+" : ""}${b.total}</div>`;
  }).join("");
  return `<div class="score-row draft-row" style="${gridStyle(n)}">
    <div class="round-label">Round ${game.round} <span class="draft-tag">(draft)</span></div>
    ${cells}
  </div>`;
}

function renderMeldTable() {
  const { isTeam, entities } = game;
  // Each entity's own current bracket, keyed by bracket index, so a row shows
  // a colored dot per entity currently sitting in it (not just whoever leads).
  const entityBracket = getTotals().map(t => getBracketIndex(t, isTeam));
  let html = `<div class="meld-table-title">Meld thresholds — ${isTeam ? "team" : "individual"} game</div>
  <table class="meld-table"><thead><tr><th>Score range</th><th>Min. meld</th></tr></thead><tbody>`;
  getBrackets(isTeam).forEach((b, bi) => {
    const here = entities.map((_, ei) => ei).filter(ei => entityBracket[ei] === bi);
    const dots = here.length ? `<span class="entity-dots">${here.map(ei => entityDotHtml(ei, entities[ei].name)).join("")}</span>` : "";
    html += `<tr class="${here.length ? "active-row" : ""}"><td>${b.label}${dots}</td><td>${b.win ? "🏆 Win!" : b.meld + " pts"}</td></tr>`;
  });
  html += `</tbody></table>`;
  document.getElementById("meld-table-wrap").innerHTML = html;
}

// ── edit modal ────────────────────────────────────────────────────────────────
let editingRoundIdx = null;
let currentModalOutEi = -1;

window.openEditModal = function(roundIdx) {
  editingRoundIdx = roundIdx;
  const r = game.rounds[roundIdx];
  document.getElementById("modal-title").textContent = `Edit Round ${r.round}`;
  document.getElementById("modal-fields").style.setProperty("--entity-count", Math.min(game.entities.length, 2));
  currentModalOutEi = !game.isTeam && r.outPlayerIdx >= 0 ? game.players[r.outPlayerIdx].entityIdx : -1;

  document.getElementById("modal-fields").innerHTML = game.entities.map((e, ei) => {
    const b = r.breakdowns[ei];
    const myPlayers = game.players.map((p, pi) => ({ ...p, pi })).filter(p => p.entityIdx === ei);
    const isIndWinner = !game.isTeam && b.wentOut;
    const wentOutHtml = myPlayers.map(p => `<div class="modal-check">
      <input type="checkbox" id="medit-out-${p.pi}" ${b.wentOut && p.pi === r.outPlayerIdx ? "checked" : ""} onchange="onModalOutChange(${p.pi})">
      <label for="medit-out-${p.pi}">${esc(p.name)} went out</label>
    </div>`).join("");
    const leftoverInner = isIndWinner
      ? `<div class="modal-went-out-note">Went out — no leftover</div>`
      : `<div class="modal-field neg-field"><label>🔴−500</label><input type="number" min="0" id="medit-nred3-${ei}" value="${b.nred3}" oninput="updateModalPreview(${ei})"></div>
         <div class="modal-field" aria-hidden="true" style="visibility:hidden"><label>&nbsp;</label><input type="number" disabled tabindex="-1"></div>
         <div class="modal-field neg-field"><label>−50</label><input type="number" min="0" id="medit-njoker-${ei}" value="${b.njoker}" oninput="updateModalPreview(${ei})"></div>
         <div class="modal-field neg-field"><label>−20</label><input type="number" min="0" id="medit-nwild-${ei}" value="${b.nwild}" oninput="updateModalPreview(${ei})"></div>
         <div class="modal-field neg-field"><label>−10</label><input type="number" min="0" id="medit-nface-${ei}" value="${b.nface}" oninput="updateModalPreview(${ei})"></div>
         <div class="modal-field neg-field"><label>−5</label><input type="number" min="0" id="medit-nlow-${ei}" value="${b.nlow}" oninput="updateModalPreview(${ei})"></div>`;
    const initTotal = calcTotal(b, isIndWinner);
    const initColor = initTotal < 0 ? "var(--red)" : "var(--green-dark)";
    return `<div class="modal-entity">
      <div class="modal-entity-title" id="modal-entity-title-${ei}">${esc(e.name)}${e.players ? "<br><span style='font-size:.65rem;opacity:.7'>" + e.players.map(esc).join(" · ") + "</span>" : ""}</div>
      <div style="margin-bottom:.5rem">
        <div class="modal-section-label" style="grid-column:unset">Who went out</div>
        ${wentOutHtml}
      </div>
      <div class="modal-score-cols">
        <div class="modal-score-col-pos pos-block">
          <div class="modal-section-label" style="grid-column:unset;border-top:none;padding-top:0;margin-top:0;color:var(--green-dark)">Scored</div>
          <div class="modal-field red-field"><label>🔴 500</label><input type="number" min="0" id="medit-rb-${ei}" value="${b.rb}" oninput="updateModalPreview(${ei})"></div>
          <div class="modal-field"><label>⚫ 300</label><input type="number" min="0" id="medit-bb-${ei}" value="${b.bb}" oninput="updateModalPreview(${ei})"></div>
          <div class="modal-field"><label>50</label><input type="number" min="0" id="medit-pjoker-${ei}" value="${b.pjoker}" oninput="updateModalPreview(${ei})"></div>
          <div class="modal-field"><label>20</label><input type="number" min="0" id="medit-pwild-${ei}" value="${b.pwild}" oninput="updateModalPreview(${ei})"></div>
          <div class="modal-field"><label>10</label><input type="number" min="0" id="medit-pface-${ei}" value="${b.pface}" oninput="updateModalPreview(${ei})"></div>
          <div class="modal-field"><label>5</label><input type="number" min="0" id="medit-plow-${ei}" value="${b.plow}" oninput="updateModalPreview(${ei})"></div>
        </div>
        <div class="modal-score-col-neg" id="modal-leftover-${ei}">
          <div class="modal-section-label" style="grid-column:unset;border-top:none;padding-top:0;margin-top:0;color:var(--red-dark)">Leftover</div>
          ${leftoverInner}
        </div>
      </div>
      <div id="modal-preview-${ei}" class="modal-preview" style="margin-top:.6rem">
        Round total: <strong style="color:${initColor}">${initTotal >= 0 ? "+" : ""}${initTotal}</strong>
      </div>
    </div>`;
  }).join("");
  document.getElementById("edit-modal").classList.add("open");
};

window.onModalOutChange = function(clickedPi) {
  game.players.forEach((_, pi) => {
    if (pi !== clickedPi) { const el = document.getElementById(`medit-out-${pi}`); if (el) el.checked = false; }
  });
  if (!game.isTeam) {
    let outPi = -1;
    for (let pi = 0; pi < game.players.length; pi++) {
      const el = document.getElementById(`medit-out-${pi}`);
      if (el && el.checked) { outPi = pi; break; }
    }
    const newOutEi = outPi >= 0 ? game.players[outPi].entityIdx : -1;
    if (newOutEi !== currentModalOutEi) {
      if (currentModalOutEi >= 0) {
        const b = game.rounds[editingRoundIdx].breakdowns[currentModalOutEi];
        const div = document.getElementById(`modal-leftover-${currentModalOutEi}`);
        if (div) div.innerHTML = `<div class="modal-section-label" style="grid-column:unset;border-top:none;padding-top:0;margin-top:0;color:var(--red-dark)">Leftover</div>
          <div class="modal-field neg-field"><label>🔴 −500</label><input type="number" min="0" id="medit-nred3-${currentModalOutEi}" value="${b.nred3}" oninput="updateModalPreview(${currentModalOutEi})"></div>
          <div class="modal-field" aria-hidden="true" style="visibility:hidden"><label>&nbsp;</label><input type="number" disabled tabindex="-1"></div>
          <div class="modal-field neg-field"><label>Joker −50</label><input type="number" min="0" id="medit-njoker-${currentModalOutEi}" value="${b.njoker}" oninput="updateModalPreview(${currentModalOutEi})"></div>
          <div class="modal-field neg-field"><label>2/Ace −20</label><input type="number" min="0" id="medit-nwild-${currentModalOutEi}" value="${b.nwild}" oninput="updateModalPreview(${currentModalOutEi})"></div>
          <div class="modal-field neg-field"><label>K–10 −10</label><input type="number" min="0" id="medit-nface-${currentModalOutEi}" value="${b.nface}" oninput="updateModalPreview(${currentModalOutEi})"></div>
          <div class="modal-field neg-field"><label>9–3 −5</label><input type="number" min="0" id="medit-nlow-${currentModalOutEi}" value="${b.nlow}" oninput="updateModalPreview(${currentModalOutEi})"></div>`;
      }
      if (newOutEi >= 0) {
        const div = document.getElementById(`modal-leftover-${newOutEi}`);
        if (div) div.innerHTML = `<div class="modal-section-label" style="grid-column:unset;border-top:none;padding-top:0;margin-top:0;color:var(--red-dark)">Leftover</div>
          <div class="modal-went-out-note">Went out — no leftover</div>`;
      }
      currentModalOutEi = newOutEi;
    }
  }
  game.entities.forEach((_, ei) => updateModalPreview(ei));
};

window.updateModalPreview = function(ei) {
  if (editingRoundIdx === null || !game) return;
  let outPi = -1;
  for (let pi = 0; pi < game.players.length; pi++) {
    const el = document.getElementById(`medit-out-${pi}`);
    if (el && el.checked) { outPi = pi; break; }
  }
  const isIndWinner = !game.isTeam && outPi >= 0 && game.players[outPi].entityIdx === ei;
  const mn = f => parseInt(document.getElementById(`medit-${f}-${ei}`)?.value) || 0;
  const b = {
    rb: mn("rb"), bb: mn("bb"),
    wentOut: outPi >= 0 && game.players[outPi].entityIdx === ei,
    pjoker: mn("pjoker"), pwild: mn("pwild"), pface: mn("pface"), plow: mn("plow"),
    nred3:  isIndWinner ? 0 : mn("nred3"),
    njoker: isIndWinner ? 0 : mn("njoker"),
    nwild:  isIndWinner ? 0 : mn("nwild"),
    nface:  isIndWinner ? 0 : mn("nface"),
    nlow:   isIndWinner ? 0 : mn("nlow"),
  };
  const total = calcTotal(b, isIndWinner);
  const el = document.getElementById(`modal-preview-${ei}`);
  if (!el) return;
  const color = total < 0 ? "var(--red)" : "var(--green-dark)";
  el.innerHTML = `Round total: <strong style="color:${color}">${total >= 0 ? "+" : ""}${total}</strong>`;
};

window.saveEdit = async function() {
  if (editingRoundIdx === null) return;
  const r = game.rounds[editingRoundIdx];
  let outPi = -1;
  game.players.forEach((_, pi) => { const el = document.getElementById(`medit-out-${pi}`); if (el && el.checked) outPi = pi; });
  r.outPlayerIdx = outPi;
  game.entities.forEach((e, ei) => {
    const outEi = outPi >= 0 ? game.players[outPi].entityIdx : -1;
    const isIndWinner = !game.isTeam && ei === outEi;
    const mn = field => { const el = document.getElementById(`medit-${field}-${ei}`); return el ? (parseInt(el.value) || 0) : 0; };
    const b = {
      rb: mn("rb"), bb: mn("bb"),
      wentOut: outPi >= 0 && game.players[outPi].entityIdx === ei,
      pjoker: mn("pjoker"), pwild: mn("pwild"), pface: mn("pface"), plow: mn("plow"),
      nred3:  isIndWinner ? 0 : mn("nred3"),
      njoker: isIndWinner ? 0 : mn("njoker"),
      nwild:  isIndWinner ? 0 : mn("nwild"),
      nface:  isIndWinner ? 0 : mn("nface"),
      nlow:   isIndWinner ? 0 : mn("nlow"),
    };
    b.total = calcTotal(b, isIndWinner);
    r.breakdowns[ei] = b;
  });
  closeModal();
  isRemoteUpdate = true;
  await pushToFirebase();
  isRemoteUpdate = false;
  renderScoreboard();
  renderMeldTable();
};

window.closeModal       = function() { document.getElementById("edit-modal").classList.remove("open"); editingRoundIdx = null; };
window.handleModalClick = function(e) { if (e.target === document.getElementById("edit-modal")) closeModal(); };

// ── entry columns ─────────────────────────────────────────────────────────────
function renderEntryColumns() {
  const { entities, players, round, isTeam, submitted } = game;
  document.getElementById("round-header").textContent = `Round ${round}`;
  const cols = document.getElementById("entry-columns");
  cols.style.setProperty("--entity-count", entities.length);
  const outPi  = getOutPlayerIdx();
  const outEi  = outPi >= 0 ? players[outPi].entityIdx : -1;
  const totals   = getTotals();
  const dealer   = getDealerInfo(round);
  const forehand = getForehandInfo(round);

  cols.innerHTML = entities.map((e, ei) => {
    const isSaved    = submitted.includes(ei);
    const curScore   = totals[ei];
    const meld       = getMeld(curScore, isTeam);
    const myPlayers  = players.map((p, pi) => ({ ...p, pi })).filter(p => p.entityIdx === ei);
    const isIndWinner = !isTeam && ei === outEi;
    const d          = isSaved ? "disabled" : "";
    const isDealer   = dealer && dealer.entityIdx === ei;
    const isForehand = forehand && forehand.entityIdx === ei;

    const teamPlayersHtml = e.players
      ? `<div class="col-players">${e.players.map(esc).join(" · ")}</div>`
      : "";
    const dealerHtml = isDealer
      ? `<div class="dealer-badge">🃏 Dealing: ${esc(dealer.playerName)}</div>`
      : "";
    const forehandHtml = isForehand
      ? `<div class="forehand-badge">▶️ Opens: ${esc(forehand.playerName)}</div>`
      : "";

    // Stays enabled even once this entity is saved — see markEntitySaved for why.
    const wentOutHtml = `<div class="went-out-section">
      <div class="col-section-label" style="color:var(--green-dark)">Who went out?</div>
      ${myPlayers.map(p => `<div class="win-row-check">
        <input type="checkbox" id="out-${p.pi}" onchange="onOutChange(${p.pi})">
        <label for="out-${p.pi}">${esc(p.name)}</label>
      </div>`).join("")}
    </div>`;

    const posColHtml = `<div class="score-col-pos pos-block">
      <div class="col-section-label">Scored</div>
      <div class="book-field red"><label>🔴 500</label><input type="number" min="0" value="0" id="rb-${ei}" ${d} oninput="onEntryInput(${ei})"></div>
      <div class="book-field black"><label>⚫ 300</label><input type="number" min="0" value="0" id="bb-${ei}" ${d} oninput="onEntryInput(${ei})"></div>
      <div class="cf"><label>50</label><input type="number" min="0" value="0" id="pjoker-${ei}" ${d} oninput="onEntryInput(${ei})"></div>
      <div class="cf"><label>20</label><input type="number" min="0" value="0" id="pwild-${ei}" ${d} oninput="onEntryInput(${ei})"></div>
      <div class="cf"><label>10</label><input type="number" min="0" value="0" id="pface-${ei}" ${d} oninput="onEntryInput(${ei})"></div>
      <div class="cf"><label>5</label><input type="number" min="0" value="0" id="plow-${ei}" ${d} oninput="onEntryInput(${ei})"></div>
    </div>`;

    const negInner = isIndWinner
      ? `<div class="neg-gone-out">Went out — no leftover</div>`
      : `<div class="neg-cf"><label>🔴 −500</label><input type="number" min="0" value="0" id="nred3-${ei}" ${d} oninput="onEntryInput(${ei})"></div>
         <div class="neg-cf" aria-hidden="true" style="visibility:hidden"><label>&nbsp;</label><input type="number" disabled tabindex="-1"></div>
         <div class="neg-cf"><label>−50</label><input type="number" min="0" value="0" id="njoker-${ei}" ${d} oninput="onEntryInput(${ei})"></div>
         <div class="neg-cf"><label>−20</label><input type="number" min="0" value="0" id="nwild-${ei}" ${d} oninput="onEntryInput(${ei})"></div>
         <div class="neg-cf"><label>−10</label><input type="number" min="0" value="0" id="nface-${ei}" ${d} oninput="onEntryInput(${ei})"></div>
         <div class="neg-cf"><label>−5</label><input type="number" min="0" value="0" id="nlow-${ei}" ${d} oninput="onEntryInput(${ei})"></div>`;
    const negColHtml = `<div class="score-col-neg neg-block" id="neg-block-${ei}">
      <div class="col-section-label">Leftover</div>
      ${negInner}
    </div>`;

    const previewHtml = `<div class="col-preview" id="preview-${ei}"><div class="prev-total">—</div><div class="prev-detail">Enter scores above</div></div>`;
    const saveHtml = isSaved
      ? `<button class="btn btn-saved" style="width:100%" disabled>✓ Saved — ${esc(e.name)}</button>`
      : `<button class="btn btn-success" style="width:100%" onclick="commitEntity(${ei})">✓ Save — ${esc(e.name)}</button>`;

    return `<div class="entity-col ${isSaved ? "col-saved" : ""}" id="col-${ei}">
      <div class="entity-col-header ${isDealer ? "header-dealer" : ""} ${isForehand ? "header-forehand" : ""}">
        <div class="col-name-row">${entityDotHtml(ei, e.name)}<div class="col-name">${esc(e.name)}</div></div>
        ${teamPlayersHtml}
        ${dealerHtml}
        ${forehandHtml}
      </div>
      <div class="entity-col-body">
        ${wentOutHtml}<div class="score-cols">${posColHtml}${negColHtml}</div>${previewHtml}
        <div style="margin-top:auto;display:flex;flex-direction:column;gap:.4rem">
          ${saveHtml}
          <div style="font-family:'IBM Plex Mono',monospace;font-size:.72rem;color:var(--text-muted);text-align:center">
            ${curScore.toLocaleString()} pts · meld ≥ ${meld !== null ? meld : "–"}
          </div>
        </div>
      </div>
    </div>`;
  }).join("");
}

function applyOutPiToUI(outPi) {
  game.players.forEach((_, pi) => {
    const el = document.getElementById(`out-${pi}`);
    if (el && !el.disabled) el.checked = (pi === outPi);
  });
  const outEi = outPi >= 0 ? (game.players[outPi]?.entityIdx ?? -1) : -1;
  if (!game.isTeam) {
    game.entities.forEach((_, ei) => {
      const block = document.getElementById(`neg-block-${ei}`);
      if (!block) return;
      const isWinner = ei === outEi;
      const d = game.submitted.includes(ei) ? "disabled" : "";
      block.innerHTML = `<div class="col-section-label">Leftover</div>` + (isWinner
        ? `<div class="neg-gone-out">Went out — no leftover</div>`
        : `<div class="neg-cf"><label>🔴 −500</label><input type="number" min="0" value="0" id="nred3-${ei}" ${d} oninput="onEntryInput(${ei})"></div>
           <div class="neg-cf" aria-hidden="true" style="visibility:hidden"><label>&nbsp;</label><input type="number" disabled tabindex="-1"></div>
           <div class="neg-cf"><label>−50</label><input type="number" min="0" value="0" id="njoker-${ei}" ${d} oninput="onEntryInput(${ei})"></div>
           <div class="neg-cf"><label>−20</label><input type="number" min="0" value="0" id="nwild-${ei}" ${d} oninput="onEntryInput(${ei})"></div>
           <div class="neg-cf"><label>−10</label><input type="number" min="0" value="0" id="nface-${ei}" ${d} oninput="onEntryInput(${ei})"></div>
           <div class="neg-cf"><label>−5</label><input type="number" min="0" value="0" id="nlow-${ei}" ${d} oninput="onEntryInput(${ei})"></div>`);
    });
  }
  game.entities.forEach((_, ei) => updateColPreview(ei));
}

window.onOutChange = function(clickedPi) {
  game.players.forEach((_, pi) => {
    if (pi !== clickedPi) { const el = document.getElementById(`out-${pi}`); if (el) el.checked = false; }
  });
  localOutTime = Date.now();
  applyOutPiToUI(getOutPlayerIdx());
  game.entities.forEach((_, ei) => {
    // Already-committed entities must still get the new outPi immediately
    // (preserving their committed:true), or their draft stays stuck at a
    // stale value and hasExactlyOneWentOut can never agree.
    if (game.submitted.includes(ei)) pushDraft(ei, true);
    else scheduleDraftPush(ei);
  });
};

function readBreakdownFromDOM(ei) {
  if (!game) return { rb:0,bb:0,wentOut:false,pjoker:0,pwild:0,pface:0,plow:0,nred3:0,njoker:0,nwild:0,nface:0,nlow:0,total:0 };
  const outPi = getOutPlayerIdx();
  const outEi = outPi >= 0 ? game.players[outPi].entityIdx : -1;
  const isIndWinner = !game.isTeam && ei === outEi;
  const b = {
    rb: num(`rb-${ei}`), bb: num(`bb-${ei}`),
    wentOut: outPi >= 0 && game.players[outPi].entityIdx === ei,
    pjoker: num(`pjoker-${ei}`), pwild: num(`pwild-${ei}`),
    pface:  num(`pface-${ei}`),  plow:  num(`plow-${ei}`),
    nred3:  isIndWinner ? 0 : num(`nred3-${ei}`),
    njoker: isIndWinner ? 0 : num(`njoker-${ei}`),
    nwild:  isIndWinner ? 0 : num(`nwild-${ei}`),
    nface:  isIndWinner ? 0 : num(`nface-${ei}`),
    nlow:   isIndWinner ? 0 : num(`nlow-${ei}`),
  };
  b.total = calcTotal(b, isIndWinner);
  return b;
}

window.updateColPreview = function(ei) {
  if (!game) return;
  const el = document.getElementById(`preview-${ei}`);
  if (!el) return;
  const b = readBreakdownFromDOM(ei);
  const after = getTotals()[ei] + b.total;
  const color = b.total < 0 ? "var(--red)" : "var(--green-dark)";
  const neg = -(b.nred3 * 500 + b.njoker * 50 + b.nwild * 20 + b.nface * 10 + b.nlow * 5);
  el.innerHTML = `<div class="prev-total" style="color:${color}">${b.total >= 0 ? "+" : ""}${b.total} <span style="font-size:.72rem;color:var(--text-muted);font-weight:400">→ ${after.toLocaleString()}</span></div>
    <div class="prev-detail">${b.rb*500+b.bb*300} bks · ${b.wentOut?100:0} win · +${b.pjoker*50+b.pwild*20+b.pface*10+b.plow*5} cards · ${neg} left</div>`;
};

window.onEntryInput = function(ei) {
  updateColPreview(ei);
  scheduleDraftPush(ei);
};

window.commitEntity = async function(ei) {
  if (!game || game.submitted.includes(ei)) return;
  const outPi = getOutPlayerIdx();
  // Mark saved locally immediately so the UI responds without waiting for Firebase
  game.submitted.push(ei);
  clearTimeout(draftTimers[ei]);
  markEntitySaved(ei);
  if (outPi >= 0) disableWentOutForOthers(game.players[outPi].entityIdx);
  // Push committed draft — all clients see this via subscribeToDrafts; finalization
  // happens there once every entity is committed.
  await pushDraft(ei, true);
};

function renderAll() {
  if (!game) return;
  renderScoreboard();
  renderMeldTable();
  if (document.getElementById("entry-area").style.display !== "none") {
    renderEntryColumns();
    // After re-rendering columns, restore current draft values (clears localEditTime so
    // all values are re-applied, recovering from the input reset that renderEntryColumns causes).
    localEditTime = {};
    if (Object.keys(currentDrafts).length > 0) applyDraftsToUI(currentDrafts);
  }
}

// ── loading / showing a game ──────────────────────────────────────────────────

// Turn a Firebase snapshot value into the in-app `game` shape.
function normalizeGame(data, submitted = [], pending = {}) {
  return {
    ...data,
    rounds:   toArray(data.rounds),
    entities: toArray(data.entities),
    players:  toArray(data.players),
    submitted: submitted || [],
    pending:   pending   || {}
  };
}

function stopListening() {
  if (syncUnsubscribe)   { syncUnsubscribe();   syncUnsubscribe = null; }
  if (draftsUnsubscribe) { draftsUnsubscribe(); draftsUnsubscribe = null; }
  currentDrafts = {};
  localEditTime = {};
}

// Send debounced writes now, while `game`, currentGameId and the score inputs
// still belong to the board being left — otherwise they fire later against
// whatever board is on screen by then.
function flushPendingWrites() {
  for (const ei of Object.keys(draftTimers)) {
    if (draftTimers[ei] == null) continue;
    clearTimeout(draftTimers[ei]);
    draftTimers[ei] = null;
    if (game && !game.submitted.includes(+ei)) pushDraft(+ei, false);
  }
  if (renameTimer != null) {
    clearTimeout(renameTimer);
    renameTimer = null;
    if (game) pushToFirebase();
  }
}

// Read a game straight from the server (for Start's "already exists?" check).
// get() answers from the cache while a listener is active on the same path, so
// if that's the board on screen, its listeners are dropped first and the board
// re-watched afterwards. A get() cut off by a forced reconnect is retried once.
async function fetchFresh(gameId) {
  const onScreen = gameId === boardId;
  if (onScreen) stopListening();
  try {
    for (let attempt = 0; ; attempt++) {
      const epoch = reconnectEpoch;
      try {
        return await get(gameRef(gameId));
      } catch (e) {
        if (attempt === 0 && epoch !== reconnectEpoch) continue;
        throw e;
      }
    }
  } finally {
    // Re-attach unless something else has taken over the listeners meanwhile.
    if (onScreen && !syncUnsubscribe && boardId === gameId) subscribeToFirebase(gameId);
  }
}

// Keep the setup fields (game mode dropdown, custom name/layout, win target)
// in step with the board actually displayed.
function syncModeSelect(gameId, data) {
  const fixedMode = Object.keys(FIXED_GAME_IDS).find(k => FIXED_GAME_IDS[k].id === gameId);
  if (data && data.target) document.getElementById("win-target").value = data.target;
  document.getElementById("game-mode").value = fixedMode || "custom";
  document.getElementById("custom-game-row").style.display = fixedMode ? "none" : "flex";
  if (!fixedMode) {
    if (data && data.mode) document.getElementById("custom-mode").value = data.mode;
    document.getElementById("custom-game-id").value = (data && data.gameCode) || gameId.replace(/^bnag-/, "");
  }
  highlightActiveLink(fixedMode || (data && data.mode));
}

// Put a freshly loaded board on screen: remember it, optionally line the
// dropdown up with it, and render the game (or "No game in progress").
function displayGame(gameId, data, syncDropdown = true) {
  localStorage.setItem("bnag-lastGameId",   gameId);
  localStorage.setItem("bnag-lastGameCode", (data && data.gameCode) || gameId.replace(/^bnag-/, ""));
  if (syncDropdown) syncModeSelect(gameId, data);
  else highlightActiveLink(data && data.mode);
  if (data) showGame(data, gameId); else showNoGame();
}

// Winner banner / entry area / tables for the current `game`.
function renderBoard() {
  const totals = getTotals();
  const winner = checkWinner(totals, game.target);
  const banner = document.getElementById("winner-banner");
  if (winner >= 0) {
    banner.textContent = `🎉 ${game.entities[winner].name} wins with ${totals[winner].toLocaleString()} points!`;
    banner.classList.add("visible");
  } else {
    banner.classList.remove("visible");
  }
  document.getElementById("entry-area").style.display = winner >= 0 ? "none" : "block";
  renderAll();
  renderPlayersBar();
}

function showGame(data, gameId) {
  game = normalizeGame(data);
  currentGameId   = data.gameId   || gameId;
  currentGameCode = data.gameCode || gameId.replace(/^bnag-/, "");
  updateGameCodeDisplay();
  renderBoard();
}

function showEmpty(message) {
  game = null;
  currentGameId   = null;
  currentGameCode = null;
  updateGameCodeDisplay();
  document.getElementById("winner-banner").classList.remove("visible");
  document.getElementById("entry-area").style.display = "none";
  document.getElementById("scoreboard").innerHTML = message;
  document.getElementById("meld-table-wrap").innerHTML = "";
  renderPlayersBar();
}
function showNoGame() {
  showEmpty(`<div class="empty-state"><div class="big">No game in progress</div>Set up players above and click Start</div>`);
}

// Switch the screen to another board. With `data` (Start / resume) it's shown
// right away; otherwise the board shows "Loading…" until the listener's first
// snapshot arrives from the server — so it's never stale, and the old board
// never lingers under a dropdown that no longer matches it.
function watchBoard(gameId, data) {
  boardSeq++;
  flushPendingWrites();
  if (syncUnsubscribe || draftsUnsubscribe) stopListening();
  currentDrafts = {};
  localEditTime = {};
  if (data) {
    syncDropdownOnLoad = true;
    displayGame(gameId, data);
    subscribeToFirebase(gameId);
    setStatus("synced");
  } else {
    showEmpty(`<div class="empty-state"><div class="big">Loading…</div></div>`);
    setStatus("syncing");
    subscribeToFirebase(gameId, true);
  }
}

function loadGame(gameId) {
  syncDropdownOnLoad = true;
  watchBoard(gameId);
}

// ── connection health ─────────────────────────────────────────────────────────
onValue(ref(db, ".info/connected"), snap => {
  isConnected = snap.val() === true;
  setStatus();  // re-render the badge without overwriting the last result
});

// After a phone/browser suspends the tab, the WebSocket is often dead but the
// SDK doesn't notice for a long time, so listeners keep showing stale data.
// Force a fresh connection; listeners then re-sync with the server. Debounced
// so one wake-up ('online' + 'visibilitychange' + 'pageshow') reconnects once.
function requestReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnectEpoch++;
    goOffline(db);
    goOnline(db);
  }, 300);
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") { hiddenAt = Date.now(); return; }
  if (hiddenAt && Date.now() - hiddenAt > 30_000) requestReconnect();
  hiddenAt = 0;
});
window.addEventListener("pageshow", e => { if (e.persisted) requestReconnect(); });
window.addEventListener("online", requestReconnect);

// ── init ──────────────────────────────────────────────────────────────────────
// Restore the last board viewed; otherwise the default dropdown selection.
{
  const savedId = localStorage.getItem("bnag-lastGameId");
  const fallback = FIXED_GAME_IDS[document.getElementById("game-mode").value] || FIXED_GAME_IDS.team2v2;
  loadGame(savedId || fallback.id);
}
