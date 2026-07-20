import { describe, expect, it } from "vitest";

import config from "../vite.config";

describe("Zendesk Vite build", () => {
  it("uses relative asset URLs inside the packaged iframe", () => {
    expect(config).toMatchObject({ base: "./" });
  });
});
