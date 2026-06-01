import { db } from "./firebase-config.js";
import {
  ref, set, onValue, get
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

// ── game ID mapping: mode → Firebase path ─────────────────────────────────────
const GAME_IDS = {
  ind3:    "bnag-dferem",
  team2v2: "bnag-utv8e9",
  team3v3: "bnag-xv2w4e"
};

// ── meld brackets ─────────────────────────────────────────────────────────────
const MELD_IND = [
  { label:"< 1,000",       min:-Infinity, max:1000,    meld:50  },
  { label:"1,000 – 1,999", min:1000,      max:2000,    meld:90  },
  { label:"2,000 – 2,999", min:2000,      max:3000,    meld:120 },
  { label:"3,000 – 3,999", min:3000,      max:4000,    meld:150 },
  { label:"4,000 – 4,999", min:4000,      max:5000,    meld:180 },
  { label:"5,000 – 5,999", min:5000,      max:6000,    meld:210 },
  { label:"≥ 6,000",       min:6000,      max:Infinity, meld:null, win:true }
];
const MELD_TEAM = [
  { label:"< 1,300",        min:-Infinity, max:1300,    meld:50  },
  { label:"1,300 – 2,499",  min:1300,      max:2500,    meld:90  },
  { label:"2,500 – 4,599",  min:2500,      max:4600,    meld:120 },
  { label:"4,600 – 7,499",  min:4600,      max:7500,    meld:150 },
  { label:"7,500 – 8,999",  min:7500,      max:9000,    meld:180 },
  { label:"9,000 – 9,999",  min:9000,      max:10000,   meld:210 },
  { label:"≥ 10,000",       min:10000,     max:Infinity, meld:null, win:true }
];
function getBrackets(isTeam) { return isTeam ? MELD_TEAM : MELD_IND; }
function getMeld(score, isTeam) {
  for (const b of getBrackets(isTeam)) if (score >= b.min && score < b.max) return b.win ? null : b.meld;
  return 210;
}
function isTeamMode(m) { return m === "team2v2" || m === "team3v3"; }

// ── breakdown calc ────────────────────────────────────────────────────────────
function calcTotal(b, isIndWinner) {
  const books = b.rb * 500 + b.bb * 300;
  const win   = b.wentOut ? 100 : 0;
  const pos   = b.pjoker * 50 + b.pwild * 20 + b.pface * 10 + b.plow * 5;
  const neg   = isIndWinner ? 0
    : -(b.nred3 * 500 + b.njoker * 50 + b.nwild * 20 + b.nface * 10 + b.nlow * 5);
  return books + win + pos + neg;
}

// ── game state ────────────────────────────────────────────────────────────────
let game = null;
let syncUnsubscribe = null; // Firebase listener unsubscribe handle

function buildGame(mode, target, playerNames) {
  const n = id => playerNames[id] || id;
  if (mode === "ind3") {
    const names = [n("P1"), n("P2"), n("P3")];
    return { mode, isTeam: false, target,
      players: names.map((name, i) => ({ name, entityIdx: i })),
      entities: names.map(name => ({ name })),
      rounds: [], round: 1, submitted: [], pending: {} };
  }
  if (mode === "team2v2") {
    const pl = [
      { name: n("T1P1"), entityIdx: 0 }, { name: n("T1P2"), entityIdx: 0 },
      { name: n("T2P1"), entityIdx: 1 }, { name: n("T2P2"), entityIdx: 1 }
    ];
    return { mode, isTeam: true, target, players: pl,
      entities: [
        { name: "Team 1", players: [pl[0].name, pl[1].name] },
        { name: "Team 2", players: [pl[2].name, pl[3].name] }
      ],
      rounds: [], round: 1, submitted: [], pending: {} };
  }
  if (mode === "team3v3") {
    const pl = [
      { name: n("T1P1"), entityIdx: 0 }, { name: n("T1P2"), entityIdx: 0 }, { name: n("T1P3"), entityIdx: 0 },
      { name: n("T2P1"), entityIdx: 1 }, { name: n("T2P2"), entityIdx: 1 }, { name: n("T2P3"), entityIdx: 1 }
    ];
    return { mode, isTeam: true, target, players: pl,
      entities: [
        { name: "Team 1", players: [pl[0].name, pl[1].name, pl[2].name] },
        { name: "Team 2", players: [pl[3].name, pl[4].name, pl[5].name] }
      ],
      rounds: [], round: 1, submitted: [], pending: {} };
  }
}

// ── Firebase sync ─────────────────────────────────────────────────────────────
function gameRef() {
  return ref(db, "games/" + GAME_IDS[game.mode]);
}

// Push full game state to Firebase (called after every round commit or edit)
async function pushToFirebase() {
  const payload = {
    mode:     game.mode,
    isTeam:   game.isTeam,
    target:   game.target,
    players:  game.players,
    entities: game.entities,
    rounds:   game.rounds,
    round:    game.round
    // submitted and pending are transient — not synced
  };
  try {
    await set(gameRef(), payload);
    setStatus("synced");
  } catch (e) {
    setStatus("error");
    console.error("Firebase write error:", e);
  }
}

// Subscribe to live updates from Firebase
function subscribeToFirebase(mode) {
  if (syncUnsubscribe) syncUnsubscribe();
  const path = ref(db, "games/" + GAME_IDS[mode]);
  syncUnsubscribe = onValue(path, snapshot => {
    const data = snapshot.val();
    if (!data) return; // nothing in DB yet
    // Merge remote state into game, preserving local transient fields
    const localSubmitted = game ? game.submitted : [];
    const localPending   = game ? game.pending   : {};
    game = Object.assign({}, data, { submitted: localSubmitted, pending: localPending });
    // Restore Infinity (JSON doesn't support it — meld brackets are constants so no issue)
    setStatus("synced");
    renderAll();
  }, err => {
    setStatus("error");
    console.error("Firebase read error:", err);
  });
}

function setStatus(state) {
  const el = document.getElementById("sync-status");
  if (!el) return;
  const states = {
    synced:      { text: "● synced",       color: "var(--green)" },
    syncing:     { text: "○ syncing…",     color: "var(--gold-dark)" },
    error:       { text: "✕ sync error",   color: "var(--red)" },
    offline:     { text: "◌ local only",   color: "var(--text-muted)" }
  };
  const s = states[state] || states.offline;
  el.textContent = s.text;
  el.style.color = s.color;
}

// ── helpers ───────────────────────────────────────────────────────────────────
function num(id)  { const el = document.getElementById(id); return el ? (parseInt(el.value) || 0) : 0; }
function chk(id)  { const el = document.getElementById(id); return el ? el.checked : false; }
function getTotals() {
  const t = game.entities.map(() => 0);
  for (const r of game.rounds) r.breakdowns.forEach((b, i) => t[i] += b.total);
  return t;
}
function checkWinner(totals) {
  for (let i = 0; i < totals.length; i++) if (totals[i] >= game.target) return i;
  return -1;
}
function gridStyle(n) { return `grid-template-columns:72px repeat(${n},1fr)`; }
function getOutPlayerIdx() {
  for (let i = 0; i < game.players.length; i++) if (chk(`out-${i}`)) return i;
  return -1;
}

// ── setup UI ──────────────────────────────────────────────────────────────────
function onModeChange() {
  const mode = document.getElementById("game-mode").value;
  document.getElementById("win-target").value = isTeamMode(mode) ? 10000 : 6000;
  renderPlayerNameInputs();
  highlightActiveLink(mode);
}
window.onModeChange = onModeChange;

function highlightActiveLink(mode) {
  document.querySelectorAll(".game-link").forEach(a => a.classList.remove("active"));
  const el = document.getElementById({ ind3:"link-ind3", team2v2:"link-team2v2", team3v3:"link-team3v3" }[mode]);
  if (el) el.classList.add("active");
}

function renderPlayerNameInputs() {
  const mode = document.getElementById("game-mode").value;
  const container = document.getElementById("player-names-setup");
  container.innerHTML = "";
  const configs = {
    ind3:    [["P1","Player 1"],["P2","Player 2"],["P3","Player 3"]],
    team2v2: [["T1P1","T1-P1"],["T2P1","T2-P1"],["T1P2","T1-P2"],["T2P2","T2-P2"]],
    team3v3: [["T1P1","T1-P1"],["T2P1","T2-P1"],["T1P2","T1-P2"],["T2P2","T2-P2"],["T1P3","T1-P3"],["T2P3","T2-P3"]]
  };
  for (const [id, ph] of configs[mode]) {
    const wrap = document.createElement("div");
    wrap.className = "player-label";
    wrap.innerHTML = `<span id="label-${id}">${ph}</span><input class="player-name-input" id="name-${id}" placeholder="${ph}" value="${ph}" oninput="refreshNameLabels()">`;
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

function getPlayerNames(mode) {
  const v = id => { const el = document.getElementById("name-" + id); return el ? (el.value.trim() || el.placeholder) : id; };
  const keys = {
    ind3:    ["P1","P2","P3"],
    team2v2: ["T1P1","T1P2","T2P1","T2P2"],
    team3v3: ["T1P1","T1P2","T1P3","T2P1","T2P2","T2P3"]
  };
  const names = {};
  for (const k of keys[mode]) names[k] = v(k);
  return names;
}

async function startGame() {
  const mode   = document.getElementById("game-mode").value;
  const target = parseInt(document.getElementById("win-target").value) || 6000;
  const names  = getPlayerNames(mode);

  // Check if a game already exists in Firebase for this mode
  setStatus("syncing");
  const snapshot = await get(ref(db, "games/" + GAME_IDS[mode]));
  if (snapshot.exists()) {
    const existing = snapshot.val();
    const confirm = window.confirm(
      `A game is already in progress (Round ${existing.round}, started with players: ` +
      `${existing.players.map(p => p.name).join(", ")}).\n\nStart fresh? (OK = new game, Cancel = resume existing)`
    );
    if (!confirm) {
      // Resume: just subscribe and let Firebase push the existing state
      game = Object.assign({}, existing, { submitted: [], pending: {} });
      subscribeToFirebase(mode);
      document.getElementById("winner-banner").classList.remove("visible");
      document.getElementById("entry-area").style.display = "block";
      renderAll();
      return;
    }
  }

  game = buildGame(mode, target, names);
  document.getElementById("winner-banner").classList.remove("visible");
  document.getElementById("entry-area").style.display = "block";
  await pushToFirebase();
  subscribeToFirebase(mode);
  renderAll();
}
window.startGame = startGame;

// ── scoreboard ────────────────────────────────────────────────────────────────
function renderScoreboard() {
  const { entities, rounds, isTeam } = game;
  const n = entities.length;
  let html = `<div class="scoreboard-header" style="${gridStyle(n)}">
    <div>Rd</div>
    ${entities.map(e => `<div style="text-align:right">${e.name}${e.players ? "<br><span style='font-size:.62rem;opacity:.55'>" + e.players.join(" / ") + "</span>" : ""}</div>`).join("")}
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
    const winner = checkWinner(totals);
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
  const n = game.entities.length;
  document.getElementById("modal-fields").style.gridTemplateColumns = `repeat(${Math.min(n, 2)}, 1fr)`;

  document.getElementById("modal-fields").innerHTML = game.entities.map((e, ei) => {
    const b = r.breakdowns[ei];
    const myPlayers = game.players.map((p, pi) => ({ ...p, pi })).filter(p => p.entityIdx === ei);
    const isIndWinner = !game.isTeam && b.wentOut;
    const wentOutHtml = myPlayers.map(p => `<div class="modal-check">
      <input type="checkbox" id="medit-out-${p.pi}" ${b.wentOut && p.pi === r.outPlayerIdx ? "checked" : ""} onchange="onModalOutChange(${p.pi})">
      <label for="medit-out-${p.pi}">${p.name} went out</label>
    </div>`).join("");

    return `<div class="modal-entity">
      <div class="modal-entity-title">${e.name}${e.players ? "<br><span style='font-size:.65rem;opacity:.7'>" + e.players.join(" · ") + "</span>" : ""}</div>
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
        <div class="modal-section-label">Leftover cards (−)</div>
        ${isIndWinner
          ? `<div style="grid-column:1/-1;font-size:.75rem;color:var(--green-dark);font-style:italic">Went out — no leftover</div>`
          : `<div class="modal-field neg-field"><label>Red 3 −500</label><input type="number" min="0" id="medit-nred3-${ei}" value="${b.nred3}"></div>
             <div class="modal-field neg-field"><label>Joker −50</label><input type="number" min="0" id="medit-njoker-${ei}" value="${b.njoker}"></div>
             <div class="modal-field neg-field"><label>2/Ace −20</label><input type="number" min="0" id="medit-nwild-${ei}" value="${b.nwild}"></div>
             <div class="modal-field neg-field"><label>K–10 −10</label><input type="number" min="0" id="medit-nface-${ei}" value="${b.nface}"></div>
             <div class="modal-field neg-field"><label>9–3 −5</label><input type="number" min="0" value="${b.nlow}" id="medit-nlow-${ei}"></div>`
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
  setStatus("syncing");
  await pushToFirebase();
  renderScoreboard();
  renderMeldTable();
};

window.closeModal = function() { document.getElementById("edit-modal").classList.remove("open"); editingRoundIdx = null; };
window.handleModalClick = function(e) { if (e.target === document.getElementById("edit-modal")) closeModal(); };

// ── entry columns ─────────────────────────────────────────────────────────────
function renderEntryColumns() {
  const { entities, players, round, isTeam, submitted } = game;
  document.getElementById("round-header").textContent = `Round ${round}`;
  const cols = document.getElementById("entry-columns");
  cols.style.gridTemplateColumns = `repeat(${entities.length}, 1fr)`;
  const outPi = getOutPlayerIdx();
  const outEi = outPi >= 0 ? players[outPi].entityIdx : -1;
  const totals = getTotals();

  cols.innerHTML = entities.map((e, ei) => {
    const isSaved = submitted.includes(ei);
    const curScore = totals[ei];
    const meld = getMeld(curScore, isTeam);
    const myPlayers = players.map((p, pi) => ({ ...p, pi })).filter(p => p.entityIdx === ei);
    const isIndWinner = !isTeam && ei === outEi;
    const d = isSaved ? "disabled" : "";

    const wentOutHtml = `<div class="went-out-section">
      <div class="col-section-label" style="color:var(--green-dark)">Who went out?</div>
      ${myPlayers.map(p => `<div class="win-row-check">
        <input type="checkbox" id="out-${p.pi}" onchange="onOutChange(${p.pi})" ${isSaved ? "disabled" : ""}>
        <label for="out-${p.pi}">${p.name}</label>
      </div>`).join("")}
    </div>`;

    const booksHtml = `<div>
      <div class="col-section-label">Books</div>
      <div class="books-row">
        <div class="book-field red"><label>🔴 Red ×500</label><input type="number" min="0" value="0" id="rb-${ei}" ${d} onchange="updateColPreview(${ei})"></div>
        <div class="book-field black"><label>⚫ Black ×300</label><input type="number" min="0" value="0" id="bb-${ei}" ${d} onchange="updateColPreview(${ei})"></div>
      </div>
    </div>`;

    const posHtml = `<div>
      <div class="col-section-label">Cards scored (+)</div>
      <div class="card-grid-2">
        <div class="cf"><label>Joker ×50</label><input type="number" min="0" value="0" id="pjoker-${ei}" ${d} onchange="updateColPreview(${ei})"></div>
        <div class="cf"><label>2/Ace ×20</label><input type="number" min="0" value="0" id="pwild-${ei}" ${d} onchange="updateColPreview(${ei})"></div>
        <div class="cf"><label>K–10 ×10</label><input type="number" min="0" value="0" id="pface-${ei}" ${d} onchange="updateColPreview(${ei})"></div>
        <div class="cf"><label>9–4 ×5</label><input type="number" min="0" value="0" id="plow-${ei}" ${d} onchange="updateColPreview(${ei})"></div>
      </div>
    </div>`;

    const negInner = isIndWinner
      ? `<div class="neg-gone-out">Went out — no leftover</div>`
      : `<div class="card-grid-2" id="neg-wrap-${ei}">
          <div class="neg-cf"><label>Red 3 −500</label><input type="number" min="0" value="0" id="nred3-${ei}" ${d} onchange="updateColPreview(${ei})"></div>
          <div class="neg-cf"><label>Joker −50</label><input type="number" min="0" value="0" id="njoker-${ei}" ${d} onchange="updateColPreview(${ei})"></div>
          <div class="neg-cf"><label>2/Ace −20</label><input type="number" min="0" value="0" id="nwild-${ei}" ${d} onchange="updateColPreview(${ei})"></div>
          <div class="neg-cf"><label>K–10 −10</label><input type="number" min="0" value="0" id="nface-${ei}" ${d} onchange="updateColPreview(${ei})"></div>
          <div class="neg-cf"><label>9–3 −5</label><input type="number" min="0" value="0" id="nlow-${ei}" ${d} onchange="updateColPreview(${ei})"></div>
        </div>`;
    const negHtml = `<div class="neg-block" id="neg-block-${ei}"><div class="col-section-label">Leftover (−)</div>${negInner}</div>`;

    const previewHtml = `<div class="col-preview" id="preview-${ei}"><div class="prev-total">—</div><div class="prev-detail">Enter scores above</div></div>`;
    const saveHtml = isSaved
      ? `<button class="btn btn-saved" style="width:100%" disabled>✓ Saved — ${e.name}</button>`
      : `<button class="btn btn-success" style="width:100%" onclick="commitEntity(${ei})">✓ Save — ${e.name}</button>`;

    return `<div class="entity-col ${isSaved ? "col-saved" : ""}" id="col-${ei}">
      <div class="entity-col-header">
        <div class="col-name">${e.name}</div>
        ${e.players ? `<div class="col-players">${e.players.join(" · ")}</div>` : ""}
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
      const isSaved = game.submitted.includes(ei);
      const d = isSaved ? "disabled" : "";
      block.innerHTML = `<div class="col-section-label">Leftover (−)</div>` + (isWinner
        ? `<div class="neg-gone-out">Went out — no leftover</div>`
        : `<div class="card-grid-2" id="neg-wrap-${ei}">
            <div class="neg-cf"><label>Red 3 −500</label><input type="number" min="0" value="0" id="nred3-${ei}" ${d} onchange="updateColPreview(${ei})"></div>
            <div class="neg-cf"><label>Joker −50</label><input type="number" min="0" value="0" id="njoker-${ei}" ${d} onchange="updateColPreview(${ei})"></div>
            <div class="neg-cf"><label>2/Ace −20</label><input type="number" min="0" value="0" id="nwild-${ei}" ${d} onchange="updateColPreview(${ei})"></div>
            <div class="neg-cf"><label>K–10 −10</label><input type="number" min="0" value="0" id="nface-${ei}" ${d} onchange="updateColPreview(${ei})"></div>
            <div class="neg-cf"><label>9–3 −5</label><input type="number" min="0" value="0" id="nlow-${ei}" ${d} onchange="updateColPreview(${ei})"></div>
          </div>`);
    });
  }
  game.entities.forEach((_, ei) => updateColPreview(ei));
};

function readBreakdownFromDOM(ei) {
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
      const b = Object.assign({}, game.pending[i].breakdown);
      const isIndWinner = !game.isTeam && game.players[finalOutPi] && game.players[finalOutPi].entityIdx === i;
      if (isIndWinner) { b.nred3=0; b.njoker=0; b.nwild=0; b.nface=0; b.nlow=0; }
      b.wentOut = finalOutPi >= 0 && game.players[finalOutPi].entityIdx === i;
      b.total = calcTotal(b, isIndWinner);
      return b;
    });
    game.rounds.push({ round: game.round, outPlayerIdx: finalOutPi, breakdowns });
    game.round++;
    game.submitted = [];
    game.pending = {};

    const totals = getTotals();
    const winner = checkWinner(totals);
    if (winner >= 0) {
      const banner = document.getElementById("winner-banner");
      banner.textContent = `🎉 ${game.entities[winner].name} wins with ${totals[winner].toLocaleString()} points!`;
      banner.classList.add("visible");
      document.getElementById("entry-area").style.display = "none";
    } else {
      renderEntryColumns();
    }
    setStatus("syncing");
    await pushToFirebase();
    renderScoreboard();
    renderMeldTable();
    window.scrollTo(0, 0);
  } else {
    // Grey out this column without full re-render
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
renderPlayerNameInputs();
highlightActiveLink("ind3");