import { describe, expect, it } from "vitest";

import { normalizedPhonesMatch, normalizePhone, phonesMatch } from "./phone";

describe("ShipStation phone normalization", () => {
  it("normalizes punctuation and strips extension suffixes", () => {
    expect(normalizePhone("+1 (512) 555-0199 ext 4")).toEqual({
      digits: "15125550199",
      nationalDigits: "5125550199",
    });
  });

  it("applies an explicit country code to national numbers", () => {
    expect(normalizePhone("(20) 7946 0958", "+44")).toEqual({
      digits: "442079460958",
      nationalDigits: "2079460958",
    });
  });

  it("rejects values with fewer than seven digits", () => {
    expect(() => normalizePhone("555-019")).toThrow(
      "Phone number must contain at least seven digits",
    );
  });

  it("matches exact and equivalent last-ten values only", () => {
    expect(phonesMatch("15125550199", "(512) 555-0199")).toBe(true);
    expect(phonesMatch("5550199", "5125550199")).toBe(false);
    expect(phonesMatch("555-0199", "5550199")).toBe(true);
  });

  it("compares already-normalized phone values", () => {
    expect(
      normalizedPhonesMatch(
        normalizePhone("+1 (512) 555-0199"),
        normalizePhone("5125550199"),
      ),
    ).toBe(true);
  });
});
