import { describe, expect, it } from "vitest";

import manifest from "../zendesk/manifest.json";

describe("Zendesk installation settings", () => {
  it("preconfigures all non-secret single-tenant values", () => {
    const settings = Object.fromEntries(
      manifest.parameters.map((parameter) => [
        parameter.name,
        "default" in parameter ? parameter.default : undefined,
      ]),
    );

    expect(settings).toMatchObject({
      worker_url: "https://resolve-orchestrator.bones-baa.workers.dev",
      worker_host: "resolve-orchestrator.bones-baa.workers.dev",
      zendesk_subdomain: "solutionpeptides",
      woo_solution_peptides_base_url: "https://solutionpeptides.net",
      woo_atomik_labz_base_url: "https://atomiklabz.com",
      shipstation_mode: "auto",
    });
  });

  it("allows secure values to remain blank and preserved during updates", () => {
    const secureSettings = manifest.parameters.filter(
      (parameter) => "secure" in parameter && parameter.secure,
    );

    expect(secureSettings.length).toBeGreaterThan(0);
    expect(
      secureSettings.every((parameter) => parameter.required === false),
    ).toBe(true);
  });
});
