import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import { ZafClientProvider } from "./ZafClientProvider";

describe("App", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads the ticket-aware Resolve shell", async () => {
    const client = {
      on: vi.fn(),
      invoke: vi.fn(),
      metadata: vi.fn().mockResolvedValue({
        settings: {
          worker_url: "https://resolve.example.workers.dev",
          zendesk_subdomain: "example",
          anthropic_model: "claude-test",
          woo_solution_peptides_base_url: "https://solutionpeptides.net",
          woo_atomik_labz_base_url: "https://atomiklabz.com",
          shipstation_mode: "v2",
        },
      }),
      get: vi.fn().mockResolvedValue({
        "ticket.id": 8421,
        "ticket.subject": "Where is my order?",
        "ticket.requester": { id: 77, name: "Maya Chen" },
        "ticket.brand": {
          id: 123,
          name: "Solution Peptides",
          subdomain: "solutionpeptides",
        },
        "ticket.conversation": [],
        currentUser: { id: 9, name: "Agent" },
      }),
      request: vi.fn().mockResolvedValue({ conversations: [] }),
    };
    vi.stubGlobal("ZAFClient", { init: () => client });
    render(
      <ZafClientProvider>
        <App />
      </ZafClientProvider>,
    );

    expect(
      screen.getByRole("heading", { name: "Resolve" }),
    ).toBeInTheDocument();
    expect(await screen.findByText("Maya Chen")).toBeInTheDocument();
    expect(
      screen.getByText("Research this ticket without leaving Zendesk."),
    ).toBeInTheDocument();
  });
});
