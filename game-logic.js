export const MELD_IND = [
  { label:"< 1,000",       min:-Infinity, max:1000,    meld:50  },
  { label:"1,000 – 1,999", min:1000,      max:2000,    meld:90  },
  { label:"2,000 – 2,999", min:2000,      max:3000,    meld:120 },
  { label:"3,000 – 3,999", min:3000,      max:4000,    meld:150 },
  { label:"4,000 – 4,999", min:4000,      max:5000,    meld:180 },
  { label:"5,000 – 5,999", min:5000,      max:6000,    meld:210 },
  { label:"≥ 6,000",       min:6000,      max:Infinity, meld:null, win:true }
];

export const MELD_TEAM = [
  { label:"< 1,300",        min:-Infinity, max:1300,    meld:50  },
  { label:"1,300 – 2,499",  min:1300,      max:2500,    meld:90  },
  { label:"2,500 – 4,599",  min:2500,      max:4600,    meld:120 },
  { label:"4,600 – 7,499",  min:4600,      max:7500,    meld:150 },
  { label:"7,500 – 8,999",  min:7500,      max:9000,    meld:180 },
  { label:"9,000 – 9,999",  min:9000,      max:10000,   meld:210 },
  { label:"≥ 10,000",       min:10000,     max:Infinity, meld:null, win:true }
];

export function getBrackets(isTeam) { return isTeam ? MELD_TEAM : MELD_IND; }

export function getMeld(score, isTeam) {
  for (const b of getBrackets(isTeam)) if (score >= b.min && score < b.max) return b.win ? null : b.meld;
  return 210;
}

export function isTeamMode(m) { return m === "team2v2" || m === "team3v3"; }

// nlow covers 9–3 (including black 3, which is the same −5 value)
// nred3 is separate at −500
export function calcTotal(b, isIndWinner) {
  const books = b.rb * 500 + b.bb * 300;
  const win   = b.wentOut ? 100 : 0;
  const pos   = b.pjoker * 50 + b.pwild * 20 + b.pface * 10 + b.plow * 5;
  const neg   = isIndWinner ? 0
    : -(b.nred3 * 500 + b.njoker * 50 + b.nwild * 20 + b.nface * 10 + b.nlow * 5);
  return books + win + pos + neg;
}

export function checkWinner(totals, target) {
  for (let i = 0; i < totals.length; i++) if (totals[i] >= target) return i;
  return -1;
}

export function buildGame(mode, target, playerNames, gameId, gameCode) {
  const n = id => playerNames[id] || id;
  const base = { mode, isTeam: isTeamMode(mode), target, gameId, gameCode,
                 rounds: [], round: 1, submitted: [], pending: {} };
  if (mode === "ind3") {
    const names = [n("P1"), n("P2"), n("P3")];
    return { ...base,
      players:  names.map((name, i) => ({ name, entityIdx: i })),
      entities: names.map(name => ({ name })) };
  }
  if (mode === "team2v2") {
    const pl = [
      { name: n("T1P1"), entityIdx: 0 }, { name: n("T1P2"), entityIdx: 0 },
      { name: n("T2P1"), entityIdx: 1 }, { name: n("T2P2"), entityIdx: 1 }
    ];
    return { ...base, players: pl, entities: [
      { name: "Team 1", players: [pl[0].name, pl[1].name] },
      { name: "Team 2", players: [pl[2].name, pl[3].name] }
    ]};
  }
  if (mode === "team3v3") {
    const pl = [
      { name: n("T1P1"), entityIdx: 0 }, { name: n("T1P2"), entityIdx: 0 }, { name: n("T1P3"), entityIdx: 0 },
      { name: n("T2P1"), entityIdx: 1 }, { name: n("T2P2"), entityIdx: 1 }, { name: n("T2P3"), entityIdx: 1 }
    ];
    return { ...base, players: pl, entities: [
      { name: "Team 1", players: [pl[0].name, pl[1].name, pl[2].name] },
      { name: "Team 2", players: [pl[3].name, pl[4].name, pl[5].name] }
    ]};
  }
}
