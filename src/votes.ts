export interface ParsedVote {
  kind: "choices" | "none" | "all";
  choices: number[];
}

export interface PollTally {
  counts: number[];
  voted: string[];
  missing: string[];
}

/** Parse the reply-only poll grammar. Choices are zero-based for array indexing. */
export function parseVote(
  input: string,
  optionCount: number,
): ParsedVote | null {
  if (!Number.isInteger(optionCount) || optionCount < 1) {
    return null;
  }
  const text = input.trim().toLowerCase();
  if (!text) {
    return null;
  }
  if (text === "none") {
    return { kind: "none", choices: [] };
  }
  if (text === "all") {
    return {
      kind: "all",
      choices: Array.from({ length: optionCount }, (_, index) => index),
    };
  }
  if (!/^[0-9][0-9\s,]*$/.test(text)) {
    return null;
  }
  const tokens = text.split(/[\s,]+/u).filter(Boolean);
  const choices: number[] = [];
  for (const token of tokens) {
    const number = Number(token);
    if (!Number.isInteger(number) || number < 1 || number > optionCount) {
      return null;
    }
    const index = number - 1;
    if (!choices.includes(index)) {
      choices.push(index);
    }
  }
  if (choices.length === 0) {
    return null;
  }
  choices.sort((left, right) => left - right);
  return { kind: "choices", choices };
}

export function voteChoices(
  input: string,
  optionCount: number,
): number[] | null {
  const parsed = parseVote(input, optionCount);
  return parsed?.choices ?? null;
}

function choicesFor(value: unknown): number[] {
  if (Array.isArray(value)) {
    return value.filter(
      (choice): choice is number => Number.isInteger(choice) && choice >= 0,
    );
  }
  if (value && typeof value === "object" && "choices" in value) {
    const choices = value.choices;
    if (Array.isArray(choices)) {
      return choices.filter(
        (choice): choice is number => Number.isInteger(choice) && choice >= 0,
      );
    }
  }
  return [];
}

function isVoteMap(
  votes: ReadonlyMap<string, unknown> | Record<string, unknown>,
): votes is ReadonlyMap<string, unknown> {
  return typeof votes.get === "function";
}

/** Produce deterministic counts and missing handles from persisted votes. */
export function tallyVotes(
  optionCount: number,
  participants: readonly string[],
  votes: ReadonlyMap<string, unknown> | Record<string, unknown>,
): PollTally {
  const counts = Array.from({ length: optionCount }, () => 0);
  const voted: string[] = [];
  const seen = new Set<string>();
  const getVote = (handle: string): unknown =>
    isVoteMap(votes) ? votes.get(handle) : votes[handle];

  for (const handle of participants) {
    const vote = getVote(handle);
    if (vote === undefined) {
      continue;
    }
    if (!seen.has(handle)) {
      seen.add(handle);
      voted.push(handle);
    }
    for (const choice of choicesFor(vote)) {
      if (choice >= 0 && choice < counts.length) {
        counts[choice] += 1;
      }
    }
  }

  if (isVoteMap(votes)) {
    for (const [handle, value] of votes) {
      if (seen.has(handle)) {
        continue;
      }
      seen.add(handle);
      voted.push(handle);
      for (const choice of choicesFor(value)) {
        if (choice >= 0 && choice < counts.length) {
          counts[choice] += 1;
        }
      }
    }
  } else {
    for (const [handle, value] of Object.entries(votes)) {
      if (seen.has(handle)) {
        continue;
      }
      seen.add(handle);
      voted.push(handle);
      for (const choice of choicesFor(value)) {
        if (choice >= 0 && choice < counts.length) {
          counts[choice] += 1;
        }
      }
    }
  }

  const missing = participants.filter((handle) => !seen.has(handle));
  return { counts, voted, missing };
}
