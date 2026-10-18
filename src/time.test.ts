import { describe, expect, test } from "bun:test";
import { formatAbsolute, parseDateTime } from "./time";

describe("chat timezone date handling", () => {
  const now = Date.parse("2026-10-18T17:00:00.000Z");

  test("resolves a natural date in the supplied timezone", () => {
    const parsed = parseDateTime("tomorrow at 7pm", now, "America/Los_Angeles");
    expect(parsed).not.toBeNull();
    expect(formatAbsolute(parsed as number, "America/Los_Angeles")).toContain(
      "7:00 PM",
    );
  });

  test("renders an absolute date rather than a machine-local relative date", () => {
    const parsed = parseDateTime(
      "Friday 10/23 at 7pm",
      now,
      "America/New_York",
    );
    expect(parsed).not.toBeNull();
    expect(formatAbsolute(parsed as number, "America/New_York")).toContain(
      "10/23",
    );
  });

  test("uses the target date's offset across daylight saving changes", () => {
    expect(
      parseDateTime(
        "tomorrow at 7pm",
        Date.parse("2026-10-31T17:00:00Z"),
        "America/Los_Angeles",
      ),
    ).toBe(Date.parse("2026-11-02T03:00:00Z"));
    expect(
      parseDateTime(
        "tomorrow at 7pm",
        Date.parse("2026-03-07T17:00:00Z"),
        "America/Los_Angeles",
      ),
    ).toBe(Date.parse("2026-03-09T02:00:00Z"));
  });

  test("rejects nonexistent local times and honors explicit offsets", () => {
    expect(
      parseDateTime(
        "March 8 2026 at 2:30am",
        Date.parse("2026-03-07T17:00:00Z"),
        "America/Los_Angeles",
      ),
    ).toBeNull();
    expect(
      parseDateTime("2026-11-02T19:00:00Z", now, "America/Los_Angeles"),
    ).toBe(Date.parse("2026-11-02T19:00:00Z"));
  });

  test("rejects an invalid timezone or input", () => {
    expect(parseDateTime("tomorrow", now, "Not/AZone")).toBeNull();
    expect(parseDateTime("", now, "America/Los_Angeles")).toBeNull();
  });
});
