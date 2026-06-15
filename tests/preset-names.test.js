/**
 * Tests for the preset-name filtering logic.
 * The real updatePresetList() reads .player-name-input DOM nodes and filters
 * PRESET_NAMES. Here we replicate that pure computation so it can be unit-tested
 * without a browser.
 */
import { describe, it, expect } from "vitest";

const PRESET_NAMES = ["Marvin","Sandra","Becky","Pankaj","Juan","Laurie","Frances","Abhishek","Gaurav"];

// Pure version of updatePresetList's filtering step:
// given a list of currently-entered values, return remaining preset names.
function availablePresets(enteredValues) {
  const used = new Set(enteredValues.map(v => v.trim()).filter(Boolean));
  return PRESET_NAMES.filter(n => !used.has(n));
}

describe("availablePresets", () => {
  it("all names available when nothing entered", () => {
    expect(availablePresets([])).toEqual(PRESET_NAMES);
  });

  it("all names available when only placeholder strings are entered", () => {
    // Placeholder strings like "T1-P1" are not preset names
    expect(availablePresets(["T1-P1", "T2-P1", "T1-P2", "T2-P2"])).toEqual(PRESET_NAMES);
  });

  it("removes a name that was entered in one slot", () => {
    const result = availablePresets(["Marvin", "T2-P1", "T1-P2", "T2-P2"]);
    expect(result).not.toContain("Marvin");
    expect(result).toHaveLength(PRESET_NAMES.length - 1);
  });

  it("removes multiple used names", () => {
    const result = availablePresets(["Marvin", "Pankaj", "Gaurav", "T2-P2"]);
    expect(result).not.toContain("Marvin");
    expect(result).not.toContain("Pankaj");
    expect(result).not.toContain("Gaurav");
    expect(result).toHaveLength(PRESET_NAMES.length - 3);
  });

  it("is case-sensitive (partial match is not a match)", () => {
    const result = availablePresets(["marvin"]); // lowercase
    expect(result).toContain("Marvin"); // "Marvin" (title case) still available
  });

  it("trims whitespace from entered values before comparing", () => {
    const result = availablePresets(["  Marvin  "]);
    expect(result).not.toContain("Marvin");
  });

  it("ignores empty strings", () => {
    const result = availablePresets(["", "  ", "Pankaj"]);
    expect(result).not.toContain("Pankaj");
    expect(result).toHaveLength(PRESET_NAMES.length - 1);
  });

  it("handles duplicate entries: same name in multiple slots counts as one", () => {
    const result = availablePresets(["Marvin", "Marvin"]);
    expect(result).not.toContain("Marvin");
    expect(result).toHaveLength(PRESET_NAMES.length - 1);
  });

  it("returns empty array when all 9 preset names are used", () => {
    expect(availablePresets(PRESET_NAMES)).toEqual([]);
  });

  it("preserves PRESET_NAMES order for remaining names", () => {
    const result = availablePresets(["Pankaj"]);
    const expected = PRESET_NAMES.filter(n => n !== "Pankaj");
    expect(result).toEqual(expected);
  });

  it("all 9 preset names are present in the constant", () => {
    expect(PRESET_NAMES).toContain("Marvin");
    expect(PRESET_NAMES).toContain("Sandra");
    expect(PRESET_NAMES).toContain("Becky");
    expect(PRESET_NAMES).toContain("Pankaj");
    expect(PRESET_NAMES).toContain("Juan");
    expect(PRESET_NAMES).toContain("Laurie");
    expect(PRESET_NAMES).toContain("Frances");
    expect(PRESET_NAMES).toContain("Abhishek");
    expect(PRESET_NAMES).toContain("Gaurav");
    expect(PRESET_NAMES).toHaveLength(9);
  });
});
