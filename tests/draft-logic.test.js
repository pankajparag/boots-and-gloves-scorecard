import { describe, it, expect } from "vitest";
import {
  canFinalize,
  allCommitted,
  hasExactlyOneWentOut,
  computeFinalOutPi,
  buildBreakdownsFromDrafts,
} from "../game-logic.js";

// ── allCommitted ──────────────────────────────────────────────────────────────
describe("allCommitted", () => {
  const round = 3;

  it("returns true when all entities committed for the current round", () => {
    const drafts = {
      0: { committed: true, round: 3 },
      1: { committed: true, round: 3 },
    };
    expect(allCommitted(drafts, round, 2)).toBe(true);
  });

  it("returns false when one entity is not yet committed", () => {
    const drafts = {
      0: { committed: true,  round: 3 },
      1: { committed: false, round: 3 },
    };
    expect(allCommitted(drafts, round, 2)).toBe(false);
  });

  it("returns false when one entity draft is missing entirely", () => {
    const drafts = {
      0: { committed: true, round: 3 },
    };
    expect(allCommitted(drafts, round, 2)).toBe(false);
  });

  it("returns false when a draft belongs to a different round (stale)", () => {
    const drafts = {
      0: { committed: true, round: 2 },  // stale
      1: { committed: true, round: 3 },
    };
    expect(allCommitted(drafts, round, 2)).toBe(false);
  });

  it("returns false for empty drafts", () => {
    expect(allCommitted({}, round, 2)).toBe(false);
  });

  it("works for 3-entity game (team3v3 or ind3)", () => {
    const drafts = {
      0: { committed: true, round: 1 },
      1: { committed: true, round: 1 },
      2: { committed: true, round: 1 },
    };
    expect(allCommitted(drafts, 1, 3)).toBe(true);
  });
});

// ── hasExactlyOneWentOut ───────────────────────────────────────────────────────
describe("hasExactlyOneWentOut", () => {
  it("returns false when nobody is recorded as going out", () => {
    const drafts = { 0: { outPi: -1 }, 1: { outPi: -1 } };
    expect(hasExactlyOneWentOut(drafts, 2)).toBe(false);
  });

  it("returns true when every entity agrees on the same player", () => {
    const drafts = { 0: { outPi: 0 }, 1: { outPi: 0 } };
    expect(hasExactlyOneWentOut(drafts, 2)).toBe(true);
  });

  it("returns false when entities disagree on who went out", () => {
    const drafts = { 0: { outPi: 0 }, 1: { outPi: 2 } };
    expect(hasExactlyOneWentOut(drafts, 2)).toBe(false);
  });

  it("treats a missing draft as outPi = -1", () => {
    const drafts = { 0: { outPi: 0 } };
    expect(hasExactlyOneWentOut(drafts, 2)).toBe(false);
  });
});

// ── canFinalize ───────────────────────────────────────────────────────────────
describe("canFinalize", () => {
  const round = 3;

  it("returns true when all entities committed and exactly one player went out", () => {
    const drafts = {
      0: { committed: true, round: 3, outPi: 0 },
      1: { committed: true, round: 3, outPi: 0 },
    };
    expect(canFinalize(drafts, round, 2)).toBe(true);
  });

  it("returns false when all committed but nobody went out", () => {
    const drafts = {
      0: { committed: true, round: 3, outPi: -1 },
      1: { committed: true, round: 3, outPi: -1 },
    };
    expect(canFinalize(drafts, round, 2)).toBe(false);
  });

  it("returns false when all committed but entities disagree on who went out", () => {
    const drafts = {
      0: { committed: true, round: 3, outPi: 0 },
      1: { committed: true, round: 3, outPi: 1 },
    };
    expect(canFinalize(drafts, round, 2)).toBe(false);
  });

  it("returns false when one entity is not yet committed", () => {
    const drafts = {
      0: { committed: true,  round: 3, outPi: 0 },
      1: { committed: false, round: 3, outPi: 0 },
    };
    expect(canFinalize(drafts, round, 2)).toBe(false);
  });

  it("returns false when one entity draft is missing entirely", () => {
    const drafts = {
      0: { committed: true, round: 3, outPi: 0 },
    };
    expect(canFinalize(drafts, round, 2)).toBe(false);
  });

  it("returns false when a draft belongs to a different round (stale)", () => {
    const drafts = {
      0: { committed: true, round: 2, outPi: 0 },  // stale
      1: { committed: true, round: 3, outPi: 0 },
    };
    expect(canFinalize(drafts, round, 2)).toBe(false);
  });

  it("returns false for empty drafts", () => {
    expect(canFinalize({}, round, 2)).toBe(false);
  });

  it("works for 3-entity game (team3v3 or ind3)", () => {
    const drafts = {
      0: { committed: true, round: 1, outPi: 2 },
      1: { committed: true, round: 1, outPi: 2 },
      2: { committed: true, round: 1, outPi: 2 },
    };
    expect(canFinalize(drafts, 1, 3)).toBe(true);
  });
});

// ── computeFinalOutPi ─────────────────────────────────────────────────────────
describe("computeFinalOutPi", () => {
  it("returns -1 when no entity has outPi set", () => {
    const drafts = {
      0: { outPi: -1 },
      1: { outPi: -1 },
    };
    expect(computeFinalOutPi(drafts, 2)).toBe(-1);
  });

  it("returns the outPi from the entity that went out", () => {
    const drafts = {
      0: { outPi: 0 },
      1: { outPi: -1 },
    };
    expect(computeFinalOutPi(drafts, 2)).toBe(0);
  });

  it("last non-(-1) value wins when multiple entities claim outPi", () => {
    // Should not happen in a real game but the function should be deterministic
    const drafts = {
      0: { outPi: 0 },
      1: { outPi: 2 },
    };
    expect(computeFinalOutPi(drafts, 2)).toBe(2);
  });

  it("returns -1 when drafts are empty", () => {
    expect(computeFinalOutPi({}, 2)).toBe(-1);
  });

  it("handles missing entity drafts gracefully", () => {
    // entity 1 draft missing — treat as outPi = -1
    const drafts = { 0: { outPi: 1 } };
    expect(computeFinalOutPi(drafts, 2)).toBe(1);
  });
});

// ── buildBreakdownsFromDrafts ─────────────────────────────────────────────────
describe("buildBreakdownsFromDrafts — team mode (isTeam = true)", () => {
  const entities = [{ name: "Team 1" }, { name: "Team 2" }];
  const players  = [
    { name: "Alice", entityIdx: 0 },
    { name: "Bob",   entityIdx: 0 },
    { name: "Carol", entityIdx: 1 },
    { name: "Dave",  entityIdx: 1 },
  ];

  it("computes correct totals for both teams with no one going out", () => {
    const drafts = {
      0: { rb:1, bb:0, pjoker:0, pwild:0, pface:0, plow:0, nred3:0, njoker:0, nwild:0, nface:0, nlow:0 },
      1: { rb:0, bb:1, pjoker:0, pwild:0, pface:0, plow:0, nred3:0, njoker:0, nwild:0, nface:0, nlow:0 },
    };
    const [b0, b1] = buildBreakdownsFromDrafts(drafts, entities, players, true, -1);
    expect(b0.total).toBe(500);   // 1 red book = 500
    expect(b1.total).toBe(300);   // 1 black book = 300
    expect(b0.wentOut).toBe(false);
    expect(b1.wentOut).toBe(false);
  });

  it("marks team that went out and adds +100 win bonus", () => {
    const drafts = {
      0: { rb:1, bb:0, pjoker:0, pwild:0, pface:0, plow:0, nred3:0, njoker:0, nwild:0, nface:0, nlow:0, outPi:0 },
      1: { rb:0, bb:1, pjoker:0, pwild:0, pface:0, plow:0, nred3:0, njoker:1, nwild:0, nface:0, nlow:0, outPi:-1 },
    };
    // Player 0 is in entity 0 (Team 1) — Team 1 went out
    const [b0, b1] = buildBreakdownsFromDrafts(drafts, entities, players, true, 0);
    expect(b0.wentOut).toBe(true);
    expect(b0.total).toBe(600);   // 500 red + 100 win
    expect(b1.wentOut).toBe(false);
    // In team mode leftover still applies to the losing team
    expect(b1.total).toBe(300 - 50);  // 300 black − 1 joker
  });

  it("leftover cards reduce score for non-winning team", () => {
    const drafts = {
      0: { rb:0, bb:0, pjoker:0, pwild:0, pface:0, plow:0, nred3:1, njoker:0, nwild:0, nface:0, nlow:0 },
      1: { rb:0, bb:0, pjoker:0, pwild:0, pface:0, plow:0, nred3:0, njoker:0, nwild:0, nface:2, nlow:0 },
    };
    const [b0, b1] = buildBreakdownsFromDrafts(drafts, entities, players, true, -1);
    expect(b0.total).toBe(-500);  // 1 red3 leftover
    expect(b1.total).toBe(-20);   // 2 face-card leftovers × −10
  });
});

describe("buildBreakdownsFromDrafts — individual mode (isTeam = false)", () => {
  const entities = [{ name: "P1" }, { name: "P2" }, { name: "P3" }];
  const players  = [
    { name: "P1", entityIdx: 0 },
    { name: "P2", entityIdx: 1 },
    { name: "P3", entityIdx: 2 },
  ];

  it("winner gets no leftover penalty even if leftover values are set in draft", () => {
    const drafts = {
      0: { rb:2, bb:0, pjoker:0, pwild:0, pface:0, plow:0, nred3:1, njoker:0, nwild:0, nface:0, nlow:0, outPi:0 },
      1: { rb:0, bb:0, pjoker:0, pwild:0, pface:0, plow:0, nred3:0, njoker:0, nwild:0, nface:0, nlow:2 },
      2: { rb:0, bb:1, pjoker:0, pwild:0, pface:0, plow:0, nred3:0, njoker:0, nwild:0, nface:0, nlow:0 },
    };
    // Player 0 (entity 0) went out
    const [b0, b1, b2] = buildBreakdownsFromDrafts(drafts, entities, players, false, 0);
    expect(b0.wentOut).toBe(true);
    expect(b0.nred3).toBe(0);           // leftover zeroed for winner
    expect(b0.total).toBe(1000 + 100);  // 2 red books + win bonus, no leftover
    expect(b1.total).toBe(-10);         // 2 × nlow −5
    expect(b2.total).toBe(300);         // 1 black book
  });

  it("non-winner retains leftover penalty", () => {
    const drafts = {
      0: { rb:0, bb:0, pjoker:0, pwild:0, pface:0, plow:0, nred3:0, njoker:0, nwild:0, nface:0, nlow:0, outPi:1 },
      1: { rb:1, bb:0, pjoker:1, pwild:0, pface:0, plow:0, nred3:0, njoker:0, nwild:0, nface:0, nlow:0 },
      2: { rb:0, bb:0, pjoker:0, pwild:0, pface:0, plow:0, nred3:0, njoker:2, nwild:0, nface:0, nlow:0 },
    };
    // Player 1 (entity 1) went out
    const [b0, b1, b2] = buildBreakdownsFromDrafts(drafts, entities, players, false, 1);
    expect(b0.wentOut).toBe(false);
    expect(b1.wentOut).toBe(true);
    expect(b1.total).toBe(500 + 50 + 100); // 1 red + 1 joker + win
    expect(b2.total).toBe(-100);            // 2 joker leftover × −50
  });
});
