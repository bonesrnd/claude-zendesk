import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AssistantSettings } from "./AssistantSettings";

describe("AssistantSettings", () => {
  it("shows the active admin-controlled model and effort", () => {
    render(<AssistantSettings model="claude-sonnet-5" effort="medium" />);

    expect(screen.getByText("claude-sonnet-5")).toBeInTheDocument();
    expect(screen.getByText("Medium")).toBeInTheDocument();
    expect(screen.getByText(/Zendesk Admin Center/i)).toBeInTheDocument();
  });
});
