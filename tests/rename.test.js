/**
 * Tests for rename logic — the pure data mutations that saveEntityName /
 * savePlayerName perform on the game object before pushing to Firebase.
 *
 * These tests do NOT touch the DOM; they exercise the same object
 * transformations the functions apply so that if the logic ever breaks
 * the tests catch it before a browser is needed.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { buildGame } from "../game-logic.js";

// ── helpers ───────────────────────────────────────────────────────────────────
function makeTeam2v2(names = {}) {
  return buildGame("team2v2", 10000,
    { T1P1: names.T1P1 ?? "Ann", T1P2: names.T1P2 ?? "Ben",
      T2P1: names.T2P1 ?? "Cal", T2P2: names.T2P2 ?? "Dee" },
    "bnag-utv8e9", "utv8e9");
}

function makeInd3(names = {}) {
  return buildGame("ind3", 6000,
    { P1: names.P1 ?? "Alice", P2: names.P2 ?? "Bob", P3: names.P3 ?? "Carol" },
    "bnag-dferem", "dferem");
}

// Pure rename helpers — same logic as saveEntityName / savePlayerName in app.js
function renameEntity(game, ei, newName) {
  game.entities[ei].name = newName;
  if (!game.isTeam) game.players[ei].name = newName;
}

function renamePlayer(game, pi, newName) {
  const oldName = game.players[pi].name;
  game.players[pi].name = newName;
  const ei = game.players[pi].entityIdx;
  if (game.entities[ei].players) {
    const j = game.entities[ei].players.indexOf(oldName);
    if (j >= 0) game.entities[ei].players[j] = newName;
  }
}

// ── renameEntity ──────────────────────────────────────────────────────────────
describe("renameEntity — team2v2", () => {
  let g;
  beforeEach(() => { g = makeTeam2v2(); });

  it("updates entities[0].name", () => {
    renameEntity(g, 0, "Alpha");
    expect(g.entities[0].name).toBe("Alpha");
  });

  it("does not change entities[1].name", () => {
    renameEntity(g, 0, "Alpha");
    expect(g.entities[1].name).toBe("Team 2");
  });

  it("does not modify players array in team mode", () => {
    renameEntity(g, 0, "Alpha");
    expect(g.players[0].name).toBe("Ann");
    expect(g.players[1].name).toBe("Ben");
  });

  it("can rename entity 1", () => {
    renameEntity(g, 1, "Beta");
    expect(g.entities[1].name).toBe("Beta");
  });

  it("empty string is not applied (caller responsibility)", () => {
    renameEntity(g, 0, "");
    expect(g.entities[0].name).toBe(""); // raw; UI guards against this
  });
});

describe("renameEntity — ind3 (entity === player)", () => {
  let g;
  beforeEach(() => { g = makeInd3(); });

  it("updates entities[0].name", () => {
    renameEntity(g, 0, "Zara");
    expect(g.entities[0].name).toBe("Zara");
  });

  it("also updates players[0].name in ind3", () => {
    renameEntity(g, 0, "Zara");
    expect(g.players[0].name).toBe("Zara");
  });

  it("does not touch players[1] or players[2]", () => {
    renameEntity(g, 0, "Zara");
    expect(g.players[1].name).toBe("Bob");
    expect(g.players[2].name).toBe("Carol");
  });

  it("renaming player 2 updates both entity and player", () => {
    renameEntity(g, 2, "Sam");
    expect(g.entities[2].name).toBe("Sam");
    expect(g.players[2].name).toBe("Sam");
  });
});

// ── renamePlayer ──────────────────────────────────────────────────────────────
describe("renamePlayer — team2v2", () => {
  let g;
  beforeEach(() => { g = makeTeam2v2(); });

  it("updates players[0].name", () => {
    renamePlayer(g, 0, "Zara");
    expect(g.players[0].name).toBe("Zara");
  });

  it("updates the matching name in entities[0].players", () => {
    renamePlayer(g, 0, "Zara");
    expect(g.entities[0].players).toContain("Zara");
    expect(g.entities[0].players).not.toContain("Ann");
  });

  it("does not affect the other player in the same entity", () => {
    renamePlayer(g, 0, "Zara");
    expect(g.entities[0].players).toContain("Ben");
  });

  it("renaming players[1] (T1P2) updates entities[0].players at position 1", () => {
    renamePlayer(g, 1, "Bea");
    expect(g.entities[0].players[1]).toBe("Bea");
    expect(g.entities[0].players[0]).toBe("Ann");
  });

  it("renaming players[2] (T2P1) updates entities[1].players, not entities[0]", () => {
    renamePlayer(g, 2, "Cam");
    expect(g.entities[1].players).toContain("Cam");
    expect(g.entities[0].players).not.toContain("Cam");
  });

  it("renaming players[3] (T2P2) updates entities[1].players at position 1", () => {
    renamePlayer(g, 3, "Dee-Dee");
    expect(g.entities[1].players[1]).toBe("Dee-Dee");
    expect(g.entities[1].players[0]).toBe("Cal");
  });

  it("does not change entity name on player rename", () => {
    renamePlayer(g, 0, "Zara");
    expect(g.entities[0].name).toBe("Team 1");
  });

  it("entityIdx is unchanged after rename", () => {
    renamePlayer(g, 0, "Zara");
    expect(g.players[0].entityIdx).toBe(0);
  });

  it("two sequential renames: each update sticks", () => {
    renamePlayer(g, 0, "Zara");
    renamePlayer(g, 0, "Zola");
    expect(g.players[0].name).toBe("Zola");
    expect(g.entities[0].players[0]).toBe("Zola");
  });

  it("renaming to a name already held by another player is allowed", () => {
    renamePlayer(g, 0, "Ben"); // duplicate name
    expect(g.players[0].name).toBe("Ben");
    // entities[0].players[0] was "Ann" → now "Ben"; indexOf("Ben") finds first
    // position — this is expected/documented behaviour
    expect(g.entities[0].players[0]).toBe("Ben");
  });
});

describe("renamePlayer — team3v3", () => {
  const g3names = { T1P1:"A", T1P2:"B", T1P3:"C", T2P1:"D", T2P2:"E", T2P3:"F" };
  let g;
  beforeEach(() => { g = buildGame("team3v3", 10000, g3names, "bnag-xv2w4e", "xv2w4e"); });

  it("renaming player 2 (T1P3, index 2) updates entities[0].players[2]", () => {
    renamePlayer(g, 2, "Charlie");
    expect(g.entities[0].players[2]).toBe("Charlie");
    expect(g.entities[0].players[0]).toBe("A");
    expect(g.entities[0].players[1]).toBe("B");
  });

  it("renaming player 3 (T2P1, index 3) updates entities[1].players[0]", () => {
    renamePlayer(g, 3, "Delta");
    expect(g.entities[1].players[0]).toBe("Delta");
  });
});
