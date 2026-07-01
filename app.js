import { db } from "./firebase-config.js";
import {
  ref, set, onValue, get
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import {
  getBrackets, getMeld, isTeamMode, calcTotal, checkWinner, buildGame,
  canFinalize, computeFinalOutPi, buildBreakdownsFromDrafts
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

// ── Enter-to-advance ──────────────────────────────────────────────────────────
// Numeric keypads have no Tab key, so Enter mimics Tab: move focus to the next
// score field instead of doing nothing (number inputs have no form to submit).
document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const target = e.target;
  if (!(target instanceof HTMLInputElement) || target.type !== "number") return;
  if (!target.closest(".score-cols, .modal-field")) return;
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

// ── Firebase sync ─────────────────────────────────────────────────────────────
function gameRef(id)   { return ref(db, "games/"  + (id || currentGameId)); }
function draftsRef(id) { return ref(db, "drafts/" + (id || currentGameId)); }

async function pushToFirebase() {
  if (!currentGameId) return;
  const payload = {
    mode:     game.mode,
    isTeam:   game.isTeam,
    target:   game.target,
    gameId:   game.gameId,
    gameCode: game.gameCode,
    players:  game.players,
    entities: game.entities,
    rounds:   game.rounds,
    round:    game.round
  };
  try {
    setStatus("syncing");
    await set(gameRef(), payload);
    setStatus("synced");
  } catch (e) {
    setStatus("error");
    console.error("Firebase write error:", e);
  }
}

function subscribeToFirebase(gameId) {
  if (syncUnsubscribe) { syncUnsubscribe(); syncUnsubscribe = null; }
  subscribeToDrafts(gameId);
  const path = gameRef(gameId);
  syncUnsubscribe = onValue(path, snapshot => {
    if (isRemoteUpdate) return;
    const data = snapshot.val();
    if (!data) { setStatus("synced"); return; }
    if (!game) { setStatus("synced"); return; }
    const roundChanged = data.round !== game.round;
    if (roundChanged) { currentDrafts = {}; localEditTime = {}; }
    const sub = roundChanged ? [] : (game.submitted || []);
    const pen = roundChanged ? {} : (game.pending   || {});
    game = { ...data, rounds: toArray(data.rounds), entities: toArray(data.entities), players: toArray(data.players), submitted: sub, pending: pen };
    currentGameId   = data.gameId   || gameId;
    currentGameCode = data.gameCode || "";
    setStatus("synced");
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
  game.players.forEach((p, pi) => {
    if (p.entityIdx === ei) { const el = document.getElementById(`out-${pi}`); if (el) el.disabled = true; }
  });
  updateColPreview(ei);
}

function shouldFinalize(drafts) {
  if (!game) return false;
  return canFinalize(drafts, game.round, game.entities.length);
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

  try {
    await set(draftsRef(), null);
    const totals = getTotals();
    const winner = checkWinner(totals, game.target);
    isRemoteUpdate = true;
    await pushToFirebase();
    isRemoteUpdate = false;
    if (winner >= 0) {
      document.getElementById("winner-banner").textContent =
        `🎉 ${game.entities[winner].name} wins with ${totals[winner].toLocaleString()} points!`;
      document.getElementById("winner-banner").classList.add("visible");
      document.getElementById("entry-area").style.display = "none";
    } else {
      renderEntryColumns();
    }
    renderScoreboard();
    renderMeldTable();
    renderPlayersBar();
    window.scrollTo(0, 0);
  } finally {
    isFinalizingRound = false;
  }
}

function setStatus(state) {
  const el = document.getElementById("sync-status");
  if (!el) return;
  const s = {
    synced:  { text: "● synced",     color: "#1a6b3a" },
    syncing: { text: "○ syncing…",   color: "#9a7410" },
    error:   { text: "✕ sync error", color: "#c0392b" },
  }[state] || { text: "◌ offline", color: "#6b6b80" };
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
function gridStyle(n) { return `grid-template-columns:72px repeat(${n},1fr)`; }
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
  if (!isCustom) {
    const fixed = FIXED_GAME_IDS[mode];
    if (!fixed) return;
    try {
      const snapshot = await get(gameRef(fixed.id));
      if (snapshot.exists()) {
        const data = snapshot.val();
        if (data.target) document.getElementById("win-target").value = data.target;
        if (syncUnsubscribe) { syncUnsubscribe(); syncUnsubscribe = null; }
        game = { ...data, rounds: toArray(data.rounds), entities: toArray(data.entities), players: toArray(data.players), submitted: [], pending: {} };
        currentGameId   = fixed.id;
        currentGameCode = fixed.code;
        localStorage.setItem("bnag-lastGameId",   fixed.id);
        localStorage.setItem("bnag-lastGameCode", fixed.code);
        updateGameCodeDisplay();
        subscribeToFirebase(fixed.id);
        const totals = getTotals();
        const winner  = checkWinner(totals, game.target);
        document.getElementById("winner-banner").classList.remove("visible");
        document.getElementById("entry-area").style.display = "none";
        if (winner >= 0) {
          document.getElementById("winner-banner").textContent =
            `🎉 ${game.entities[winner].name} wins with ${totals[winner].toLocaleString()} points!`;
          document.getElementById("winner-banner").classList.add("visible");
          renderScoreboard();
          renderMeldTable();
        } else {
          document.getElementById("entry-area").style.display = "block";
          renderAll();
        }
        renderPlayersBar();
      } else {
        if (syncUnsubscribe) { syncUnsubscribe(); syncUnsubscribe = null; }
        game = null;
        currentGameId   = null;
        currentGameCode = null;
        updateGameCodeDisplay();
        document.getElementById("winner-banner").classList.remove("visible");
        document.getElementById("entry-area").style.display = "none";
        document.getElementById("scoreboard").innerHTML =
          `<div class="empty-state"><div class="big">No game in progress</div>Set up players above and click Start</div>`;
        document.getElementById("meld-table-wrap").innerHTML = "";
        renderPlayersBar();
      }
    } catch (e) { /* offline — ignore */ }
  }
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

  currentGameId   = gameId;
  currentGameCode = gameCode;
  setStatus("syncing");

  let snapshot;
  try {
    snapshot = await get(gameRef(gameId));
  } catch (e) {
    setStatus("error");
    alert("Could not connect to Firebase. Check your connection.");
    return;
  }

  if (snapshot.exists()) {
    const existing = snapshot.val();
    const resume = window.confirm(
      `A game "${gameCode}" already exists (Round ${existing.round}, players: ${toArray(existing.players).map(p => p.name).join(", ")}).\n\nCancel = resume existing · OK = start fresh`
    );
    if (!resume) {
      game = { ...existing, rounds: toArray(existing.rounds), entities: toArray(existing.entities), players: toArray(existing.players), submitted: [], pending: {} };
      localStorage.setItem("bnag-lastGameId",   gameId);
      localStorage.setItem("bnag-lastGameCode", gameCode);
      subscribeToFirebase(gameId);
      document.getElementById("winner-banner").classList.remove("visible");
      document.getElementById("entry-area").style.display = "block";
      updateGameCodeDisplay();
      renderAll();
      renderPlayersBar();
      return;
    }
  }

  game = buildGame(effectiveMode, target, defaultPlayerNames(effectiveMode), gameId, gameCode);
  document.getElementById("winner-banner").classList.remove("visible");
  document.getElementById("entry-area").style.display = "block";
  updateGameCodeDisplay();

  localStorage.setItem("bnag-lastGameId",   gameId);
  localStorage.setItem("bnag-lastGameCode", gameCode);

  // Clear stale drafts from any previous game at this path before writing fresh state
  currentDrafts = {};
  localEditTime = {};
  // Silently ignore permission errors — if the Firebase rules don't yet include
  // the drafts path the game start should still succeed.
  try { await set(draftsRef(gameId), null); } catch (_) {}

  isRemoteUpdate = true;
  await pushToFirebase();
  isRemoteUpdate = false;

  subscribeToFirebase(gameId);
  renderAll();
  renderPlayersBar();
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

  const currentDealer = getDealerInfo(game.round);
  const nextDealer    = getDealerInfo(game.round + 1);
  const dealerBlockHtml = `<div id="pbar-dealer-block" class="pbar-dealer-block">
    <div class="pbar-dealer-round" id="pbar-dealer-round">Round ${game.round}</div>
    ${currentDealer ? `<div class="pbar-dealer-current">🃏 <strong>${esc(currentDealer.playerName)}</strong></div>` : ""}
    ${nextDealer    ? `<div class="pbar-dealer-next">Next: <strong>${esc(nextDealer.playerName)}</strong></div>` : ""}
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
  const dealer = getDealerInfo(game.round);
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
  });
  const dealerBlock = document.getElementById("pbar-dealer-block");
  if (dealerBlock) {
    const roundEl = document.getElementById("pbar-dealer-round");
    if (roundEl) roundEl.textContent = `Round ${game.round}`;
    const currentDealer = getDealerInfo(game.round);
    const nextDealer    = getDealerInfo(game.round + 1);
    const currentEl = dealerBlock.querySelector(".pbar-dealer-current strong");
    if (currentEl && currentDealer) currentEl.textContent = currentDealer.playerName;
    const nextEl = dealerBlock.querySelector(".pbar-dealer-next strong");
    if (nextEl && nextDealer) nextEl.textContent = nextDealer.playerName;
  }
}

// ── scoreboard ────────────────────────────────────────────────────────────────
function renderScoreboard() {
  const { entities, rounds, isTeam } = game;
  const n = entities.length;

  const headerCells = entities.map(e => {
    const playerHtml = e.players
      ? `<br><span class="entity-player-names">${e.players.map(esc).join(' / ')}</span>`
      : "";
    return `<div style="text-align:right"><span class="entity-display-name">${esc(e.name)}</span>${playerHtml}</div>`;
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
  const { isTeam } = game;
  const maxScore = Math.max(...getTotals(), 0);
  let html = `<div class="meld-table-title">Meld thresholds — ${isTeam ? "team" : "individual"} game</div>
  <table class="meld-table"><thead><tr><th>Score range</th><th>Min. meld</th></tr></thead><tbody>`;
  for (const b of getBrackets(isTeam)) {
    const active = maxScore >= b.min && maxScore < b.max;
    html += `<tr class="${active ? "active-row" : ""}"><td>${b.label}</td><td>${b.win ? "🏆 Win!" : b.meld + " pts"}</td></tr>`;
  }
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
  document.getElementById("modal-fields").style.gridTemplateColumns = `repeat(${Math.min(game.entities.length, 2)}, 1fr)`;
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
  cols.style.gridTemplateColumns = `repeat(${entities.length}, 1fr)`;
  const outPi  = getOutPlayerIdx();
  const outEi  = outPi >= 0 ? players[outPi].entityIdx : -1;
  const totals = getTotals();
  const dealer = getDealerInfo(round);

  cols.innerHTML = entities.map((e, ei) => {
    const isSaved    = submitted.includes(ei);
    const curScore   = totals[ei];
    const meld       = getMeld(curScore, isTeam);
    const myPlayers  = players.map((p, pi) => ({ ...p, pi })).filter(p => p.entityIdx === ei);
    const isIndWinner = !isTeam && ei === outEi;
    const d          = isSaved ? "disabled" : "";
    const isDealer   = dealer && dealer.entityIdx === ei;

    const teamPlayersHtml = e.players
      ? `<div class="col-players">${e.players.map(esc).join(" · ")}</div>`
      : "";
    const dealerHtml = isDealer
      ? `<div class="dealer-badge">🃏 Dealing: ${esc(dealer.playerName)}</div>`
      : "";

    const wentOutHtml = `<div class="went-out-section">
      <div class="col-section-label" style="color:var(--green-dark)">Who went out?</div>
      ${myPlayers.map(p => `<div class="win-row-check">
        <input type="checkbox" id="out-${p.pi}" onchange="onOutChange(${p.pi})" ${isSaved ? "disabled" : ""}>
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
      <div class="entity-col-header ${isDealer ? "header-dealer" : ""}">
        <div class="col-name">${esc(e.name)}</div>
        ${teamPlayersHtml}
        ${dealerHtml}
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
    if (!game.submitted.includes(ei)) scheduleDraftPush(ei);
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

// ── init ──────────────────────────────────────────────────────────────────────
highlightActiveLink("team2v2");

// On page load, restore the last active game from Firebase if one was saved
(async () => {
  const savedId   = localStorage.getItem("bnag-lastGameId");
  const savedCode = localStorage.getItem("bnag-lastGameCode");
  if (!savedId) return;
  currentGameId   = savedId;
  currentGameCode = savedCode || "";
  setStatus("syncing");
  try {
    const snapshot = await get(gameRef(savedId));
    if (!snapshot.exists()) { setStatus("synced"); return; }
    const data = snapshot.val();
    game = { ...data, rounds: toArray(data.rounds), entities: toArray(data.entities), players: toArray(data.players), submitted: [], pending: {} };
    updateGameCodeDisplay();
    subscribeToFirebase(savedId);
    const totals = getTotals();
    const winner = checkWinner(totals, game.target);
    if (winner >= 0) {
      document.getElementById("winner-banner").textContent =
        `🎉 ${game.entities[winner].name} wins with ${totals[winner].toLocaleString()} points!`;
      document.getElementById("winner-banner").classList.add("visible");
      renderScoreboard();
      renderMeldTable();
    } else {
      document.getElementById("entry-area").style.display = "block";
      renderAll();
    }
    renderPlayersBar();
  } catch (e) {
    setStatus("error");
    console.error("Auto-restore error:", e);
  }
})();
