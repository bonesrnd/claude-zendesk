import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AssistantSettings } from "./AssistantSettings";

describe("AssistantSettings", () => {
  it("shows the active admin-controlled model and effort", () => {
    render(
      <AssistantSettings
        model="claude-sonnet-5"
        effort="medium"
        workerUrl="https://resolve-orchestrator.bones-baa.workers.dev"
        workerHost="resolve-orchestrator.bones-baa.workers.dev"
        zendeskSubdomain="solutionpeptides"
      />,
    );

    expect(screen.getByText("claude-sonnet-5")).toBeInTheDocument();
    expect(screen.getByText("Medium")).toBeInTheDocument();
    expect(
      screen.getByText("resolve-orchestrator.bones-baa.workers.dev"),
    ).toBeInTheDocument();
    expect(screen.getByText("solutionpeptides")).toBeInTheDocument();
    expect(screen.getByText(/Zendesk Admin Center/i)).toBeInTheDocument();
  });
});
