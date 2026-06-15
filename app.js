import { db } from "./firebase-config.js";
import {
  ref, set, onValue, get
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import {
  getBrackets, getMeld, isTeamMode, calcTotal, checkWinner, buildGame
} from "./game-logic.js";

// ── Firebase paths ────────────────────────────────────────────────────────────
// Each game mode maps to a fixed Firebase path based on the playingcards.io room code.
// Structure in Firebase:
//   games/
//     bnag-dferem/   ← Individual 3P game
//     bnag-utv8e9/   ← Team 2v2 game
//     bnag-xv2w4e/   ← Team 3v3 game
//     bnag-custom-*/  ← Custom scorecards
//
// Each path stores the ENTIRE game state as one JSON object:
//   { mode, isTeam, target, players, entities, rounds, round }
//
// rounds[] is an array of round objects:
//   { round, outPlayerIdx, breakdowns: [ {rb, bb, wentOut, pjoker, pwild, pface,
//     plow, nred3, njoker, nwild, nface, nlow, total}, ... ] }
//
// Every Save and every Edit overwrites the whole object.
// All connected phones subscribe via onValue() and re-render on every change.

const FIXED_GAME_IDS = {
  ind3:    { id: "bnag-dferem",  code: "dferem"  },
  team2v2: { id: "bnag-utv8e9",  code: "utv8e9"  },
  team3v3: { id: "bnag-xv2w4e",  code: "xv2w4e"  }
};

// ── game state ────────────────────────────────────────────────────────────────
let game = null;
let currentGameId = null;   // e.g. "bnag-dferem"
let currentGameCode = null; // e.g. "dferem"
let syncUnsubscribe = null;
let isRemoteUpdate = false; // flag to suppress re-push on incoming Firebase updates

// ── Firebase sync ─────────────────────────────────────────────────────────────
function gameRef(id) { return ref(db, "games/" + (id || currentGameId)); }

async function pushToFirebase() {
  if (!currentGameId) return;
  // Only store what needs to be shared — exclude transient UI state
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
    if (isRemoteUpdate) return; // we just wrote this, skip
    const data = snapshot.val();
    if (!data) { setStatus("synced"); return; }
    // Only apply remote updates if a game is already running locally
    if (!game) { setStatus("synced"); return; }
    // Preserve local transient fields; guard rounds against Firebase null-coercing []
    const sub = game.submitted || [];
    const pen = game.pending   || {};
    game = { ...data, rounds: data.rounds || [], submitted: sub, pending: pen };
    currentGameId   = data.gameId   || gameId;
    currentGameCode = data.gameCode || "";
    setStatus("synced");
    updateGameCodeDisplay();
    renderAll();
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
// Returns the game.players index for the j-th player belonging to entity ei
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

// ── setup UI ──────────────────────────────────────────────────────────────────
window.onModeChange = function() {
  const mode = document.getElementById("game-mode").value;
  document.getElementById("win-target").value = isTeamMode(mode) ? 10000 : 6000;
  const isCustom = mode === "custom";
  document.getElementById("custom-game-row").style.display = isCustom ? "flex" : "none";
  if (!isCustom) renderPlayerNameInputs();
  highlightActiveLink(mode);
};

function highlightActiveLink(mode) {
  document.querySelectorAll(".game-link").forEach(a => a.classList.remove("active"));
  const fixed = FIXED_GAME_IDS[mode];
  if (fixed) {
    const el = document.getElementById("link-" + mode);
    if (el) el.classList.add("active");
  }
}

window.onCustomModeChange = function() {
  const sub = document.getElementById("custom-mode").value;
  renderPlayerNameInputs(sub);
};

function renderPlayerNameInputs(modeOverride) {
  const mode = modeOverride || document.getElementById("game-mode").value;
  const effectiveMode = mode === "custom"
    ? document.getElementById("custom-mode").value
    : mode;
  const container = document.getElementById("player-names-setup");
  container.innerHTML = "";
  const configs = {
    ind3:    [["P1","Player 1"],["P2","Player 2"],["P3","Player 3"]],
    team2v2: [["T1P1","T1-P1"],["T2P1","T2-P1"],["T1P2","T1-P2"],["T2P2","T2-P2"]],
    team3v3: [["T1P1","T1-P1"],["T2P1","T2-P1"],["T1P2","T1-P2"],["T2P2","T2-P2"],["T1P3","T1-P3"],["T2P3","T2-P3"]]
  };
  for (const [id, ph] of (configs[effectiveMode] || [])) {
    const wrap = document.createElement("div");
    wrap.className = "player-label";
    wrap.innerHTML = `<span id="label-${id}">${ph}</span><input class="player-name-input" id="name-${id}" placeholder="${ph}" value="${ph}" oninput="refreshNameLabels()" list="preset-names">`;
    container.appendChild(wrap);
  }
}

window.refreshNameLabels = function() {
  document.querySelectorAll(".player-name-input").forEach(inp => {
    const id = inp.id.replace("name-", "");
    const span = document.getElementById("label-" + id);
    if (span) span.textContent = inp.value || inp.placeholder;
  });
};

function getPlayerNames(effectiveMode) {
  const v = id => { const el = document.getElementById("name-" + id); return el ? (el.value.trim() || el.placeholder) : id; };
  const keys = {
    ind3:    ["P1","P2","P3"],
    team2v2: ["T1P1","T1P2","T2P1","T2P2"],
    team3v3: ["T1P1","T1P2","T1P3","T2P1","T2P2","T2P3"]
  };
  const names = {};
  for (const k of (keys[effectiveMode] || [])) names[k] = v(k);
  return names;
}

window.startGame = async function() {
  const modeSelect    = document.getElementById("game-mode").value;
  const isCustom      = modeSelect === "custom";
  const effectiveMode = isCustom ? document.getElementById("custom-mode").value : modeSelect;
  const target        = parseInt(document.getElementById("win-target").value) || 10000;
  const names         = getPlayerNames(effectiveMode);

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

  // Check for existing game
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
      `A game "${gameCode}" already exists (Round ${existing.round}, players: ${existing.players.map(p => p.name).join(", ")}).\n\nCancel = resume existing · OK = start fresh`
    );
    if (!resume) {
      game = { ...existing, rounds: existing.rounds || [], submitted: [], pending: {} };
      subscribeToFirebase(gameId);
      document.getElementById("winner-banner").classList.remove("visible");
      document.getElementById("entry-area").style.display = "block";
      updateGameCodeDisplay();
      renderAll();
      return;
    }
  }

  game = buildGame(effectiveMode, target, names, gameId, gameCode);
  document.getElementById("winner-banner").classList.remove("visible");
  document.getElementById("entry-area").style.display = "block";
  updateGameCodeDisplay();

  isRemoteUpdate = true;
  await pushToFirebase();
  isRemoteUpdate = false;

  subscribeToFirebase(gameId);
  renderAll();
};

// ── inline rename ─────────────────────────────────────────────────────────────
window.handleRenameKeydown = function(e) {
  if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); }
  if (e.key === "Escape") { e.currentTarget.textContent = e.currentTarget.dataset.orig; e.currentTarget.blur(); }
};

window.saveEntityName = async function(ei, el) {
  if (!game) return;
  const newName = el.textContent.trim();
  if (!newName) { el.textContent = game.entities[ei].name; return; }
  game.entities[ei].name = newName;
  if (!game.isTeam) game.players[ei].name = newName; // ind3: entity === player
  el.dataset.orig = newName;
  isRemoteUpdate = true;
  await pushToFirebase();
  isRemoteUpdate = false;
  renderScoreboard();
};

window.savePlayerName = async function(pi, el) {
  if (!game || pi < 0) return;
  const newName = el.textContent.trim();
  if (!newName) { el.textContent = game.players[pi].name; return; }
  const oldName = game.players[pi].name;
  game.players[pi].name = newName;
  const ei = game.players[pi].entityIdx;
  if (game.entities[ei].players) {
    const j = game.entities[ei].players.indexOf(oldName);
    if (j >= 0) game.entities[ei].players[j] = newName;
  }
  el.dataset.orig = newName;
  isRemoteUpdate = true;
  await pushToFirebase();
  isRemoteUpdate = false;
  renderScoreboard();
};

// ── scoreboard ────────────────────────────────────────────────────────────────
function renderScoreboard() {
  const { entities, rounds, isTeam } = game;
  const n = entities.length;

  const headerCells = entities.map((e, ei) => {
    const entitySpan = `<span class="editable-name" contenteditable="true" data-orig="${esc(e.name)}"
      onblur="saveEntityName(${ei}, this)" onkeydown="handleRenameKeydown(event)">${esc(e.name)}</span>`;
    const playerSpans = e.players
      ? "<br><span style='font-size:.62rem;opacity:.55'>" +
        e.players.map((pname, j) => {
          const pi = findPlayerByPosition(ei, j);
          return `<span class="editable-name" contenteditable="true" data-orig="${esc(pname)}"
            onblur="savePlayerName(${pi}, this)" onkeydown="handleRenameKeydown(event)">${esc(pname)}</span>`;
        }).join(" / ") + "</span>"
      : "";
    return `<div style="text-align:right">${entitySpan}${playerSpans}</div>`;
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

window.openEditModal = function(roundIdx) {
  editingRoundIdx = roundIdx;
  const r = game.rounds[roundIdx];
  document.getElementById("modal-title").textContent = `Edit Round ${r.round}`;
  document.getElementById("modal-fields").style.gridTemplateColumns = `repeat(${Math.min(game.entities.length, 2)}, 1fr)`;

  document.getElementById("modal-fields").innerHTML = game.entities.map((e, ei) => {
    const b = r.breakdowns[ei];
    const myPlayers = game.players.map((p, pi) => ({ ...p, pi })).filter(p => p.entityIdx === ei);
    const isIndWinner = !game.isTeam && b.wentOut;
    const wentOutHtml = myPlayers.map(p => `<div class="modal-check">
      <input type="checkbox" id="medit-out-${p.pi}" ${b.wentOut && p.pi === r.outPlayerIdx ? "checked" : ""} onchange="onModalOutChange(${p.pi})">
      <label for="medit-out-${p.pi}">${esc(p.name)} went out</label>
    </div>`).join("");

    return `<div class="modal-entity">
      <div class="modal-entity-title">${esc(e.name)}${e.players ? "<br><span style='font-size:.65rem;opacity:.7'>" + e.players.map(esc).join(" · ") + "</span>" : ""}</div>
      <div class="modal-grid">
        <div class="modal-section-label">Who went out</div>
        <div style="grid-column:1/-1">${wentOutHtml}</div>
        <div class="modal-section-label">Books</div>
        <div class="modal-field red-field"><label>🔴 Red books</label><input type="number" min="0" id="medit-rb-${ei}" value="${b.rb}"></div>
        <div class="modal-field"><label>⚫ Black books</label><input type="number" min="0" id="medit-bb-${ei}" value="${b.bb}"></div>
        <div class="modal-section-label">Positive cards</div>
        <div class="modal-field"><label>Joker ×50</label><input type="number" min="0" id="medit-pjoker-${ei}" value="${b.pjoker}"></div>
        <div class="modal-field"><label>2/Ace ×20</label><input type="number" min="0" id="medit-pwild-${ei}" value="${b.pwild}"></div>
        <div class="modal-field"><label>K–10 ×10</label><input type="number" min="0" id="medit-pface-${ei}" value="${b.pface}"></div>
        <div class="modal-field"><label>9–4 ×5</label><input type="number" min="0" id="medit-plow-${ei}" value="${b.plow}"></div>
        <div class="modal-section-label">Leftover (−)</div>
        ${isIndWinner
          ? `<div style="grid-column:1/-1;font-size:.75rem;color:var(--green-dark);font-style:italic">Went out — no leftover</div>`
          : `<div class="modal-field neg-field"><label>Red 3 −500</label><input type="number" min="0" id="medit-nred3-${ei}" value="${b.nred3}"></div>
             <div class="modal-field neg-field"><label>Joker −50</label><input type="number" min="0" id="medit-njoker-${ei}" value="${b.njoker}"></div>
             <div class="modal-field neg-field"><label>2/Ace −20</label><input type="number" min="0" id="medit-nwild-${ei}" value="${b.nwild}"></div>
             <div class="modal-field neg-field"><label>K–10 −10</label><input type="number" min="0" id="medit-nface-${ei}" value="${b.nface}"></div>
             <div class="modal-field neg-field"><label>9–3 and below −5</label><input type="number" min="0" id="medit-nlow-${ei}" value="${b.nlow}"></div>`
        }
      </div>
    </div>`;
  }).join("");
  document.getElementById("edit-modal").classList.add("open");
};

window.onModalOutChange = function(clickedPi) {
  game.players.forEach((_, pi) => {
    if (pi !== clickedPi) { const el = document.getElementById(`medit-out-${pi}`); if (el) el.checked = false; }
  });
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

    const teamPlayersHtml = e.players
      ? `<div class="col-players">${
          e.players.map((pname, j) => {
            const pi = findPlayerByPosition(ei, j);
            return `<span class="editable-name" contenteditable="true" data-orig="${esc(pname)}"
              onblur="savePlayerName(${pi}, this)" onkeydown="handleRenameKeydown(event)">${esc(pname)}</span>`;
          }).join(" · ")
        }</div>`
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
        <div class="col-name"><span class="editable-name" contenteditable="true" data-orig="${esc(e.name)}"
          onblur="saveEntityName(${ei}, this)" onkeydown="handleRenameKeydown(event)">${esc(e.name)}</span></div>
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
renderPlayerNameInputs("team2v2");
highlightActiveLink("team2v2");
