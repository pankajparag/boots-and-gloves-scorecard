import { db } from "./firebase-config.js";
import {
  ref, set, onValue, get
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import {
  getBrackets, getMeld, isTeamMode, calcTotal, checkWinner, buildGame
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
let isRemoteUpdate = false;
let renameTimer = null; // debounce timer for name-change Firebase push

// ── Firebase sync ─────────────────────────────────────────────────────────────
function gameRef(id) { return ref(db, "games/" + (id || currentGameId)); }

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
  const path = gameRef(gameId);
  syncUnsubscribe = onValue(path, snapshot => {
    if (isRemoteUpdate) return;
    const data = snapshot.val();
    if (!data) { setStatus("synced"); return; }
    if (!game) { setStatus("synced"); return; }
    const sub = game.submitted || [];
    const pen = game.pending   || {};
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
  document.getElementById("win-target").value = isTeamMode(mode) ? 10000 : 6000;
  const isCustom = mode === "custom";
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
    }</div>`;
  } else {
    // ind3: entity name = player name, one input per player
    bar.innerHTML = `<div class="pbar-inner">${
      game.players.map((p, pi) =>
        `<input class="pbar-player-input" type="text" list="preset-names"
          value="${esc(p.name)}" placeholder="${esc(p.name)}"
          oninput="onPlayerNameInput(${pi}, this)">`
      ).join("")
    }</div>`;
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
  });
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
    <div>Rd</div>${headerCells}
  </div>`;

  if (!rounds.length) {
    html += `<div class="empty-state"><div class="big">No rounds yet</div>Enter round 1 below</div>`;
  } else {
    const totals = entities.map(() => 0);
    for (const r of rounds) {
      r.breakdowns.forEach((b, i) => totals[i] += b.total);
      html += `<div class="score-row editable-row" style="${gridStyle(n)}" onclick="openEditModal(${r.round - 1})" title="Click to edit">
        <div class="round-label">R${r.round} <span style="font-size:.6rem;color:var(--gold-dark)">✎</span></div>
        ${r.breakdowns.map(b => `<div class="score-val ${b.total < 0 ? "negative" : ""}">${b.total >= 0 ? "+" : ""}${b.total}</div>`).join("")}
      </div>`;
    }
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
      : `<div class="modal-leftover-grid">
          <div class="modal-field neg-field"><label>Red 3 −500</label><input type="number" min="0" id="medit-nred3-${ei}" value="${b.nred3}" oninput="updateModalPreview(${ei})"></div>
          <div class="modal-field neg-field"><label>Joker −50</label><input type="number" min="0" id="medit-njoker-${ei}" value="${b.njoker}" oninput="updateModalPreview(${ei})"></div>
          <div class="modal-field neg-field"><label>2/Ace −20</label><input type="number" min="0" id="medit-nwild-${ei}" value="${b.nwild}" oninput="updateModalPreview(${ei})"></div>
          <div class="modal-field neg-field"><label>K–10 −10</label><input type="number" min="0" id="medit-nface-${ei}" value="${b.nface}" oninput="updateModalPreview(${ei})"></div>
          <div class="modal-field neg-field"><label>9–3 and below −5</label><input type="number" min="0" id="medit-nlow-${ei}" value="${b.nlow}" oninput="updateModalPreview(${ei})"></div>
        </div>`;
    const initTotal = calcTotal(b, isIndWinner);
    const initColor = initTotal < 0 ? "var(--red)" : "var(--green-dark)";
    return `<div class="modal-entity">
      <div class="modal-entity-title" id="modal-entity-title-${ei}">${esc(e.name)}${e.players ? "<br><span style='font-size:.65rem;opacity:.7'>" + e.players.map(esc).join(" · ") + "</span>" : ""}</div>
      <div class="modal-grid">
        <div class="modal-section-label">Who went out</div>
        <div style="grid-column:1/-1">${wentOutHtml}</div>
        <div class="modal-section-label">Books</div>
        <div class="modal-field red-field"><label>🔴 Red books</label><input type="number" min="0" id="medit-rb-${ei}" value="${b.rb}" oninput="updateModalPreview(${ei})"></div>
        <div class="modal-field"><label>⚫ Black books</label><input type="number" min="0" id="medit-bb-${ei}" value="${b.bb}" oninput="updateModalPreview(${ei})"></div>
        <div class="modal-section-label">Positive cards</div>
        <div class="modal-field"><label>Joker ×50</label><input type="number" min="0" id="medit-pjoker-${ei}" value="${b.pjoker}" oninput="updateModalPreview(${ei})"></div>
        <div class="modal-field"><label>2/Ace ×20</label><input type="number" min="0" id="medit-pwild-${ei}" value="${b.pwild}" oninput="updateModalPreview(${ei})"></div>
        <div class="modal-field"><label>K–10 ×10</label><input type="number" min="0" id="medit-pface-${ei}" value="${b.pface}" oninput="updateModalPreview(${ei})"></div>
        <div class="modal-field"><label>9–4 ×5</label><input type="number" min="0" id="medit-plow-${ei}" value="${b.plow}" oninput="updateModalPreview(${ei})"></div>
        <div class="modal-section-label">Leftover (−)</div>
        <div id="modal-leftover-${ei}" style="grid-column:1/-1">${leftoverInner}</div>
        <div id="modal-preview-${ei}" class="modal-preview" style="grid-column:1/-1">
          Round total: <strong style="color:${initColor}">${initTotal >= 0 ? "+" : ""}${initTotal}</strong>
        </div>
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
        if (div) div.innerHTML = `<div class="modal-leftover-grid">
          <div class="modal-field neg-field"><label>Red 3 −500</label><input type="number" min="0" id="medit-nred3-${currentModalOutEi}" value="${b.nred3}" oninput="updateModalPreview(${currentModalOutEi})"></div>
          <div class="modal-field neg-field"><label>Joker −50</label><input type="number" min="0" id="medit-njoker-${currentModalOutEi}" value="${b.njoker}" oninput="updateModalPreview(${currentModalOutEi})"></div>
          <div class="modal-field neg-field"><label>2/Ace −20</label><input type="number" min="0" id="medit-nwild-${currentModalOutEi}" value="${b.nwild}" oninput="updateModalPreview(${currentModalOutEi})"></div>
          <div class="modal-field neg-field"><label>K–10 −10</label><input type="number" min="0" id="medit-nface-${currentModalOutEi}" value="${b.nface}" oninput="updateModalPreview(${currentModalOutEi})"></div>
          <div class="modal-field neg-field"><label>9–3 and below −5</label><input type="number" min="0" id="medit-nlow-${currentModalOutEi}" value="${b.nlow}" oninput="updateModalPreview(${currentModalOutEi})"></div>
        </div>`;
      }
      if (newOutEi >= 0) {
        const div = document.getElementById(`modal-leftover-${newOutEi}`);
        if (div) div.innerHTML = `<div class="modal-went-out-note">Went out — no leftover</div>`;
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

  cols.innerHTML = entities.map((e, ei) => {
    const isSaved    = submitted.includes(ei);
    const curScore   = totals[ei];
    const meld       = getMeld(curScore, isTeam);
    const myPlayers  = players.map((p, pi) => ({ ...p, pi })).filter(p => p.entityIdx === ei);
    const isIndWinner = !isTeam && ei === outEi;
    const d          = isSaved ? "disabled" : "";

    // Player names shown as plain text (not editable here — use the players bar above)
    const teamPlayersHtml = e.players
      ? `<div class="col-players">${e.players.map(esc).join(" · ")}</div>`
      : "";

    const wentOutHtml = `<div class="went-out-section">
      <div class="col-section-label" style="color:var(--green-dark)">Who went out?</div>
      ${myPlayers.map(p => `<div class="win-row-check">
        <input type="checkbox" id="out-${p.pi}" onchange="onOutChange(${p.pi})" ${isSaved ? "disabled" : ""}>
        <label for="out-${p.pi}">${esc(p.name)}</label>
      </div>`).join("")}
    </div>`;

    const booksHtml = `<div>
      <div class="col-section-label">Books</div>
      <div class="books-row">
        <div class="book-field red"><label>🔴 Red ×500</label><input type="number" min="0" value="0" id="rb-${ei}" ${d} oninput="updateColPreview(${ei})"></div>
        <div class="book-field black"><label>⚫ Black ×300</label><input type="number" min="0" value="0" id="bb-${ei}" ${d} oninput="updateColPreview(${ei})"></div>
      </div>
    </div>`;

    const posHtml = `<div>
      <div class="col-section-label">Cards scored (+)</div>
      <div class="card-grid-2">
        <div class="cf"><label>Joker ×50</label><input type="number" min="0" value="0" id="pjoker-${ei}" ${d} oninput="updateColPreview(${ei})"></div>
        <div class="cf"><label>2/Ace ×20</label><input type="number" min="0" value="0" id="pwild-${ei}" ${d} oninput="updateColPreview(${ei})"></div>
        <div class="cf"><label>K–10 ×10</label><input type="number" min="0" value="0" id="pface-${ei}" ${d} oninput="updateColPreview(${ei})"></div>
        <div class="cf"><label>9–4 ×5</label><input type="number" min="0" value="0" id="plow-${ei}" ${d} oninput="updateColPreview(${ei})"></div>
      </div>
    </div>`;

    const negInner = isIndWinner
      ? `<div class="neg-gone-out">Went out — no leftover</div>`
      : `<div class="card-grid-2" id="neg-wrap-${ei}">
          <div class="neg-cf"><label>Red 3 −500</label><input type="number" min="0" value="0" id="nred3-${ei}" ${d} oninput="updateColPreview(${ei})"></div>
          <div class="neg-cf"><label>Joker −50</label><input type="number" min="0" value="0" id="njoker-${ei}" ${d} oninput="updateColPreview(${ei})"></div>
          <div class="neg-cf"><label>2/Ace −20</label><input type="number" min="0" value="0" id="nwild-${ei}" ${d} oninput="updateColPreview(${ei})"></div>
          <div class="neg-cf"><label>K–10 −10</label><input type="number" min="0" value="0" id="nface-${ei}" ${d} oninput="updateColPreview(${ei})"></div>
          <div class="neg-cf"><label>9–3 and below −5</label><input type="number" min="0" value="0" id="nlow-${ei}" ${d} oninput="updateColPreview(${ei})"></div>
        </div>`;
    const negHtml = `<div class="neg-block" id="neg-block-${ei}"><div class="col-section-label">Leftover (−)</div>${negInner}</div>`;

    const previewHtml = `<div class="col-preview" id="preview-${ei}"><div class="prev-total">—</div><div class="prev-detail">Enter scores above</div></div>`;
    const saveHtml = isSaved
      ? `<button class="btn btn-saved" style="width:100%" disabled>✓ Saved — ${esc(e.name)}</button>`
      : `<button class="btn btn-success" style="width:100%" onclick="commitEntity(${ei})">✓ Save — ${esc(e.name)}</button>`;

    return `<div class="entity-col ${isSaved ? "col-saved" : ""}" id="col-${ei}">
      <div class="entity-col-header">
        <div class="col-name">${esc(e.name)}</div>
        ${teamPlayersHtml}
      </div>
      <div class="entity-col-body">
        ${wentOutHtml}${booksHtml}${posHtml}${negHtml}${previewHtml}
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

window.onOutChange = function(clickedPi) {
  game.players.forEach((_, pi) => {
    if (pi !== clickedPi) { const el = document.getElementById(`out-${pi}`); if (el) el.checked = false; }
  });
  const outPi = getOutPlayerIdx();
  const outEi = outPi >= 0 ? game.players[outPi].entityIdx : -1;
  if (!game.isTeam) {
    game.entities.forEach((_, ei) => {
      const block = document.getElementById(`neg-block-${ei}`);
      if (!block) return;
      const isWinner = ei === outEi;
      const d = game.submitted.includes(ei) ? "disabled" : "";
      block.innerHTML = `<div class="col-section-label">Leftover (−)</div>` + (isWinner
        ? `<div class="neg-gone-out">Went out — no leftover</div>`
        : `<div class="card-grid-2" id="neg-wrap-${ei}">
            <div class="neg-cf"><label>Red 3 −500</label><input type="number" min="0" value="0" id="nred3-${ei}" ${d} oninput="updateColPreview(${ei})"></div>
            <div class="neg-cf"><label>Joker −50</label><input type="number" min="0" value="0" id="njoker-${ei}" ${d} oninput="updateColPreview(${ei})"></div>
            <div class="neg-cf"><label>2/Ace −20</label><input type="number" min="0" value="0" id="nwild-${ei}" ${d} oninput="updateColPreview(${ei})"></div>
            <div class="neg-cf"><label>K–10 −10</label><input type="number" min="0" value="0" id="nface-${ei}" ${d} oninput="updateColPreview(${ei})"></div>
            <div class="neg-cf"><label>9–3 and below −5</label><input type="number" min="0" value="0" id="nlow-${ei}" ${d} oninput="updateColPreview(${ei})"></div>
          </div>`);
    });
  }
  game.entities.forEach((_, ei) => updateColPreview(ei));
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

window.commitEntity = async function(ei) {
  if (game.submitted.includes(ei)) return;
  const outPi = getOutPlayerIdx();
  game.pending[ei] = { breakdown: readBreakdownFromDOM(ei), outPi };
  game.submitted.push(ei);

  if (game.submitted.length === game.entities.length) {
    let finalOutPi = -1;
    game.entities.forEach((_, i) => { if (game.pending[i].outPi >= 0) finalOutPi = game.pending[i].outPi; });
    const breakdowns = game.entities.map((_, i) => {
      const b = { ...game.pending[i].breakdown };
      const isIndWinner = !game.isTeam && game.players[finalOutPi] && game.players[finalOutPi].entityIdx === i;
      if (isIndWinner) { b.nred3=0; b.njoker=0; b.nwild=0; b.nface=0; b.nlow=0; }
      b.wentOut = finalOutPi >= 0 && game.players[finalOutPi].entityIdx === i;
      b.total = calcTotal(b, isIndWinner);
      return b;
    });
    game.rounds.push({ round: game.round, outPlayerIdx: finalOutPi, breakdowns });
    game.round++;
    game.submitted = [];
    game.pending   = {};

    const totals = getTotals();
    const winner  = checkWinner(totals, game.target);
    if (winner >= 0) {
      document.getElementById("winner-banner").textContent =
        `🎉 ${game.entities[winner].name} wins with ${totals[winner].toLocaleString()} points!`;
      document.getElementById("winner-banner").classList.add("visible");
      document.getElementById("entry-area").style.display = "none";
    } else {
      renderEntryColumns();
    }
    isRemoteUpdate = true;
    await pushToFirebase();
    isRemoteUpdate = false;
    renderScoreboard();
    renderMeldTable();
    window.scrollTo(0, 0);
  } else {
    const col = document.getElementById(`col-${ei}`);
    if (col) col.classList.add("col-saved");
    const btn = col ? col.querySelector(".btn-success") : null;
    if (btn) { btn.className = "btn btn-saved"; btn.disabled = true; btn.textContent = `✓ Saved — ${game.entities[ei].name}`; }
    ["rb","bb","pjoker","pwild","pface","plow","nred3","njoker","nwild","nface","nlow"].forEach(p => {
      const inp = document.getElementById(`${p}-${ei}`); if (inp) inp.disabled = true;
    });
    game.players.forEach((p, pi) => {
      if (p.entityIdx === ei) { const el = document.getElementById(`out-${pi}`); if (el) el.disabled = true; }
    });
  }
};

function renderAll() {
  if (!game) return;
  renderScoreboard();
  renderMeldTable();
  if (document.getElementById("entry-area").style.display !== "none") {
    renderEntryColumns();
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
