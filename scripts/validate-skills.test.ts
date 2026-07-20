import { describe, expect, it } from "vitest";

import type { SkillDefinition } from "../packages/skill-sdk/src";
import { validateCredentialManifest } from "./validate-skills.mts";

const skill: SkillDefinition = {
  id: "orders",
  name: "Orders",
  version: "1.0.0",
  instructions: "Read orders",
  credentials: [
    {
      settingName: "orders_token",
      headerName: "x-resolve-orders-token",
      required: true,
      secret: true,
    },
  ],
  tools: [],
};

describe("validateCredentialManifest", () => {
  it("reports missing skill settings", () => {
    expect(validateCredentialManifest([skill], { parameters: [] })).toEqual([
      "Skill orders references missing setting orders_token",
    ]);
  });

  it("requires secure credentials to be header-scoped", () => {
    expect(
      validateCredentialManifest([skill], {
        parameters: [
          {
            name: "orders_token",
            type: "text",
            secure: true,
            scopes: ["body"],
          },
        ],
      }),
    ).toEqual(['Secure setting orders_token must declare scopes: ["header"]']);
  });

  it("accepts a correctly scoped secure setting", () => {
    expect(
      validateCredentialManifest([skill], {
        parameters: [
          {
            name: "orders_token",
            type: "text",
            secure: true,
            scopes: ["header"],
          },
        ],
      }),
    ).toEqual([]);
  });
});
