import { describe, expect, test } from "bun:test";
import { parseVote, tallyVotes } from "./votes";

describe("text poll grammar", () => {
  test("accepts numeric, none, and all replies", () => {
    expect(parseVote("1 3", 3)).toEqual({ kind: "choices", choices: [0, 2] });
    expect(parseVote("1, 3", 3)).toEqual({ kind: "choices", choices: [0, 2] });
    expect(parseVote("none", 3)).toEqual({ kind: "none", choices: [] });
    expect(parseVote("all", 3)).toEqual({ kind: "all", choices: [0, 1, 2] });
  });

  test("rejects malformed or out-of-range replies", () => {
    expect(parseVote("", 3)).toBeNull();
    expect(parseVote("1 4", 3)).toBeNull();
    expect(parseVote("all 1", 3)).toBeNull();
    expect(parseVote("Friday", 3)).toBeNull();
  });

  test("keeps counts and missing people deterministic", () => {
    const tally = tallyVotes(3, ["alice", "bob", "sam"], {
      alice: [0, 2],
      bob: [],
    });
    expect(tally.counts).toEqual([1, 0, 1]);
    expect(tally.voted).toEqual(["alice", "bob"]);
    expect(tally.missing).toEqual(["sam"]);
  });
});
