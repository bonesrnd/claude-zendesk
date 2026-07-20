import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { SkillsManager } from "./SkillsManager";

describe("SkillsManager", () => {
  it("shows capability and configuration status without secrets", async () => {
    const listSkills = vi.fn(async () => ({
      skills: [
        {
          id: "woocommerce",
          name: "WooCommerce",
          version: "1.0.0",
          configured: true,
          tools: [{ name: "woocommerce_get_order", risk: "read" as const }],
        },
      ],
    }));
    render(
      <SkillsManager
        ticketId={8421}
        worker={{
          listSkills,
          checkSkill: vi.fn(),
        }}
      />,
    );

    expect(await screen.findByText("WooCommerce")).toBeInTheDocument();
    expect(screen.getByText("Ready")).toBeInTheDocument();
    expect(screen.queryByText(/consumer key/i)).not.toBeInTheDocument();
  });

  it("runs a health check on demand", async () => {
    const user = userEvent.setup();
    const checkSkill = vi.fn(async () => ({
      id: "woocommerce",
      ok: true,
      message: "WooCommerce is reachable.",
    }));
    render(
      <SkillsManager
        ticketId={8421}
        worker={{
          listSkills: vi.fn(async () => ({
            skills: [
              {
                id: "woocommerce",
                name: "WooCommerce",
                version: "1.0.0",
                configured: true,
                tools: [],
              },
            ],
          })),
          checkSkill,
        }}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Test" }));

    expect(checkSkill).toHaveBeenCalledWith("woocommerce", 8421);
    expect(
      await screen.findByText("WooCommerce is reachable."),
    ).toBeInTheDocument();
  });
});
