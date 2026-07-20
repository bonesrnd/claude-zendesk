import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Composer } from "./Composer";

describe("Composer", () => {
  it("sends on Enter and keeps Shift+Enter as a newline", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<Composer disabled={false} onSend={onSend} />);
    const textbox = screen.getByRole("textbox", {
      name: "Ask Słones about this ticket",
    });

    await user.type(textbox, "First line{shift>}{enter}{/shift}Second line");
    expect(textbox).toHaveValue("First line\nSecond line");
    await user.keyboard("{Enter}");

    expect(onSend).toHaveBeenCalledWith("First line\nSecond line");
    expect(textbox).toHaveValue("");
  });

  it("announces the working state", () => {
    render(<Composer disabled onSend={vi.fn()} />);

    expect(screen.getByText("Słones is working…")).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toBeDisabled();
  });
});
