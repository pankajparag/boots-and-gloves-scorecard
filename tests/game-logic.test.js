import { describe, it, expect } from "vitest";
import {
  MELD_IND, MELD_TEAM,
  getBrackets, getMeld, getBracketIndex,
  isTeamMode, calcTotal,
  checkWinner, buildGame
} from "../game-logic.js";

// ── isTeamMode ────────────────────────────────────────────────────────────────
describe("isTeamMode", () => {
  it("returns true for team2v2", () => expect(isTeamMode("team2v2")).toBe(true));
  it("returns true for team3v3", () => expect(isTeamMode("team3v3")).toBe(true));
  it("returns false for ind3",   () => expect(isTeamMode("ind3")).toBe(false));
  it("returns false for unknown",() => expect(isTeamMode("custom")).toBe(false));
});

// ── getBrackets ───────────────────────────────────────────────────────────────
describe("getBrackets", () => {
  it("returns MELD_IND for individual", () => expect(getBrackets(false)).toBe(MELD_IND));
  it("returns MELD_TEAM for team",      () => expect(getBrackets(true)).toBe(MELD_TEAM));
  it("MELD_IND has 7 brackets",  () => expect(MELD_IND.length).toBe(7));
  it("MELD_TEAM has 7 brackets", () => expect(MELD_TEAM.length).toBe(7));
  it("last MELD_IND bracket is the win bracket",  () => expect(MELD_IND.at(-1).win).toBe(true));
  it("last MELD_TEAM bracket is the win bracket", () => expect(MELD_TEAM.at(-1).win).toBe(true));
  it("MELD_IND win bracket starts at 6000",  () => expect(MELD_IND.at(-1).min).toBe(6000));
  it("MELD_TEAM win bracket starts at 10000",() => expect(MELD_TEAM.at(-1).min).toBe(10000));
});

// ── getMeld ───────────────────────────────────────────────────────────────────
describe("getMeld — individual", () => {
  it("< 1000  → 50",  () => expect(getMeld(0,     false)).toBe(50));
  it("negative → 50", () => expect(getMeld(-200,  false)).toBe(50));
  it("999     → 50",  () => expect(getMeld(999,   false)).toBe(50));
  it("1000    → 90",  () => expect(getMeld(1000,  false)).toBe(90));
  it("1999    → 90",  () => expect(getMeld(1999,  false)).toBe(90));
  it("2000    → 120", () => expect(getMeld(2000,  false)).toBe(120));
  it("2999    → 120", () => expect(getMeld(2999,  false)).toBe(120));
  it("3000    → 150", () => expect(getMeld(3000,  false)).toBe(150));
  it("4000    → 180", () => expect(getMeld(4000,  false)).toBe(180));
  it("5000    → 210", () => expect(getMeld(5000,  false)).toBe(210));
  it("5999    → 210", () => expect(getMeld(5999,  false)).toBe(210));
  it("6000    → null (win)", () => expect(getMeld(6000,  false)).toBeNull());
  it("9999    → null (win)", () => expect(getMeld(9999,  false)).toBeNull());
});

describe("getMeld — team", () => {
  it("0       → 50",  () => expect(getMeld(0,     true)).toBe(50));
  it("1299    → 50",  () => expect(getMeld(1299,  true)).toBe(50));
  it("1300    → 90",  () => expect(getMeld(1300,  true)).toBe(90));
  it("2499    → 90",  () => expect(getMeld(2499,  true)).toBe(90));
  it("2500    → 120", () => expect(getMeld(2500,  true)).toBe(120));
  it("4599    → 120", () => expect(getMeld(4599,  true)).toBe(120));
  it("4600    → 150", () => expect(getMeld(4600,  true)).toBe(150));
  it("7499    → 150", () => expect(getMeld(7499,  true)).toBe(150));
  it("7500    → 180", () => expect(getMeld(7500,  true)).toBe(180));
  it("8999    → 180", () => expect(getMeld(8999,  true)).toBe(180));
  it("9000    → 210", () => expect(getMeld(9000,  true)).toBe(210));
  it("9999    → 210", () => expect(getMeld(9999,  true)).toBe(210));
  it("10000   → null (win)", () => expect(getMeld(10000, true)).toBeNull());
  it("15000   → null (win)", () => expect(getMeld(15000, true)).toBeNull());
});

// ── getBracketIndex ───────────────────────────────────────────────────────────
describe("getBracketIndex", () => {
  it("returns 0 for the lowest individual bracket", () => expect(getBracketIndex(0, false)).toBe(0));
  it("returns the matching middle bracket", () => expect(getBracketIndex(2500, false)).toBe(2));
  it("returns the win bracket index for a winning score", () => expect(getBracketIndex(6000, false)).toBe(MELD_IND.length - 1));
  it("two different scores in the same bracket give the same index", () => {
    expect(getBracketIndex(1000, false)).toBe(getBracketIndex(1999, false));
  });
  it("works for team brackets too", () => expect(getBracketIndex(2500, true)).toBe(2));
});

// ── calcTotal ─────────────────────────────────────────────────────────────────
const zero = { rb:0, bb:0, wentOut:false, pjoker:0, pwild:0, pface:0, plow:0,
                nred3:0, njoker:0, nwild:0, nface:0, nlow:0 };

describe("calcTotal", () => {
  it("all zeros → 0", () => expect(calcTotal(zero, false)).toBe(0));

  it("1 red book = 500",   () => expect(calcTotal({ ...zero, rb:1 }, false)).toBe(500));
  it("2 red books = 1000", () => expect(calcTotal({ ...zero, rb:2 }, false)).toBe(1000));
  it("1 black book = 300", () => expect(calcTotal({ ...zero, bb:1 }, false)).toBe(300));
  it("2 black books = 600",() => expect(calcTotal({ ...zero, bb:2 }, false)).toBe(600));

  it("wentOut adds 100",   () => expect(calcTotal({ ...zero, wentOut:true }, false)).toBe(100));

  it("pjoker ×50",  () => expect(calcTotal({ ...zero, pjoker:2 }, false)).toBe(100));
  it("pwild  ×20",  () => expect(calcTotal({ ...zero, pwild:3 }, false)).toBe(60));
  it("pface  ×10",  () => expect(calcTotal({ ...zero, pface:4 }, false)).toBe(40));
  it("plow   ×5",   () => expect(calcTotal({ ...zero, plow:6 }, false)).toBe(30));

  it("nred3  −500 each", () => expect(calcTotal({ ...zero, nred3:1 }, false)).toBe(-500));
  it("njoker −50 each",  () => expect(calcTotal({ ...zero, njoker:1 }, false)).toBe(-50));
  it("nwild  −20 each",  () => expect(calcTotal({ ...zero, nwild:1 }, false)).toBe(-20));
  it("nface  −10 each",  () => expect(calcTotal({ ...zero, nface:1 }, false)).toBe(-10));
  it("nlow   −5 each",   () => expect(calcTotal({ ...zero, nlow:1 }, false)).toBe(-5));

  it("isIndWinner suppresses all negative cards", () => {
    const b = { ...zero, nred3:1, njoker:2, nwild:3, nface:4, nlow:5 };
    expect(calcTotal(b, true)).toBe(0);
  });

  it("isIndWinner does not affect positive cards", () => {
    const b = { ...zero, rb:1, bb:1, wentOut:true, pjoker:1 };
    expect(calcTotal(b, true)).toBe(500 + 300 + 100 + 50);
  });

  it("mixed round with some of everything", () => {
    const b = { rb:1, bb:2, wentOut:true, pjoker:1, pwild:2, pface:3, plow:4,
                nred3:0, njoker:1, nwild:1, nface:1, nlow:1 };
    // books: 500+600=1100, win:100, pos:50+40+30+20=140, neg: -(50+20+10+5)=-85
    expect(calcTotal(b, false)).toBe(1100 + 100 + 140 - 85);
  });

  it("negative total is possible", () => {
    const b = { ...zero, nred3:2 };
    expect(calcTotal(b, false)).toBe(-1000);
  });
});

// ── checkWinner ───────────────────────────────────────────────────────────────
describe("checkWinner", () => {
  it("no winner when all below target", () => expect(checkWinner([5999, 3000], 6000)).toBe(-1));
  it("first entity wins",  () => expect(checkWinner([6000, 4000], 6000)).toBe(0));
  it("second entity wins", () => expect(checkWinner([3000, 6000], 6000)).toBe(1));
  it("exact target counts as win", () => expect(checkWinner([6000], 6000)).toBe(0));
  it("above target counts as win",  () => expect(checkWinner([7500], 6000)).toBe(0));
  it("when multiple exceed target, first index wins", () =>
    expect(checkWinner([6500, 6100], 6000)).toBe(0));
  it("respects custom target", () => expect(checkWinner([9999, 10000], 10000)).toBe(1));
  it("returns -1 for empty totals", () => expect(checkWinner([], 6000)).toBe(-1));
});

// ── buildGame ─────────────────────────────────────────────────────────────────
describe("buildGame — ind3", () => {
  const names = { P1:"Alice", P2:"Bob", P3:"Carol" };
  const g = buildGame("ind3", 6000, names, "bnag-dferem", "dferem");

  it("mode is ind3",    () => expect(g.mode).toBe("ind3"));
  it("isTeam is false", () => expect(g.isTeam).toBe(false));
  it("target stored",   () => expect(g.target).toBe(6000));
  it("gameId stored",   () => expect(g.gameId).toBe("bnag-dferem"));
  it("gameCode stored", () => expect(g.gameCode).toBe("dferem"));
  it("starts at round 1", () => expect(g.round).toBe(1));
  it("rounds is empty array", () => { expect(Array.isArray(g.rounds)).toBe(true); expect(g.rounds.length).toBe(0); });
  it("3 players", () => expect(g.players.length).toBe(3));
  it("3 entities", () => expect(g.entities.length).toBe(3));
  it("player names applied", () => expect(g.players.map(p => p.name)).toEqual(["Alice","Bob","Carol"]));
  it("each player entityIdx equals own index", () =>
    g.players.forEach((p, i) => expect(p.entityIdx).toBe(i)));
  it("entity names match player names", () =>
    expect(g.entities.map(e => e.name)).toEqual(["Alice","Bob","Carol"]));
  it("ind3 entities have no .players array", () =>
    g.entities.forEach(e => expect(e.players).toBeUndefined()));
  it("falls back to key for missing name", () => {
    const g2 = buildGame("ind3", 6000, {}, "x", "x");
    expect(g2.players[0].name).toBe("P1");
  });
});

describe("buildGame — team2v2", () => {
  const names = { T1P1:"Ann", T1P2:"Ben", T2P1:"Cal", T2P2:"Dee" };
  const g = buildGame("team2v2", 10000, names, "bnag-utv8e9", "utv8e9");

  it("mode is team2v2", () => expect(g.mode).toBe("team2v2"));
  it("isTeam is true",  () => expect(g.isTeam).toBe(true));
  it("4 players",  () => expect(g.players.length).toBe(4));
  it("2 entities", () => expect(g.entities.length).toBe(2));
  it("T1P1 and T1P2 on entity 0", () => {
    expect(g.players[0]).toMatchObject({ name:"Ann", entityIdx:0 });
    expect(g.players[1]).toMatchObject({ name:"Ben", entityIdx:0 });
  });
  it("T2P1 and T2P2 on entity 1", () => {
    expect(g.players[2]).toMatchObject({ name:"Cal", entityIdx:1 });
    expect(g.players[3]).toMatchObject({ name:"Dee", entityIdx:1 });
  });
  it("entity 0 has 2-player roster", () =>
    expect(g.entities[0].players).toEqual(["Ann","Ben"]));
  it("entity 1 has 2-player roster", () =>
    expect(g.entities[1].players).toEqual(["Cal","Dee"]));
});

describe("buildGame — team3v3", () => {
  const names = { T1P1:"A", T1P2:"B", T1P3:"C", T2P1:"D", T2P2:"E", T2P3:"F" };
  const g = buildGame("team3v3", 10000, names, "bnag-xv2w4e", "xv2w4e");

  it("6 players", () => expect(g.players.length).toBe(6));
  it("2 entities", () => expect(g.entities.length).toBe(2));
  it("first 3 players on entity 0", () =>
    [0,1,2].forEach(i => expect(g.players[i].entityIdx).toBe(0)));
  it("last 3 players on entity 1", () =>
    [3,4,5].forEach(i => expect(g.players[i].entityIdx).toBe(1)));
  it("entity 0 has 3-player roster", () =>
    expect(g.entities[0].players).toEqual(["A","B","C"]));
  it("entity 1 has 3-player roster", () =>
    expect(g.entities[1].players).toEqual(["D","E","F"]));
});
