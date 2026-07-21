import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ActionProposal } from "./ActionProposal";

const proposal = {
  id: "turn_1",
  action: "zendesk_update_customer_profile" as const,
  targetId: 77,
  before: {
    phone: "+15551230000",
    user_fields: { customer_tier: "silver" },
  },
  changes: {
    phone: "+15559870000",
    user_fields: { customer_tier: "gold" },
  },
  expiresAt: "2026-07-21T12:10:00.000Z",
};

describe("ActionProposal", () => {
  it("announces the target and renders exact before and after values", () => {
    render(
      <ActionProposal
        proposal={proposal}
        now={new Date("2026-07-21T12:00:00.000Z")}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveAccessibleName("Confirm customer profile update");
    expect(dialog).toHaveAccessibleDescription(
      expect.stringContaining("Customer profile 77"),
    );
    expect(screen.getByText("+15551230000")).toBeInTheDocument();
    expect(screen.getByText("+15559870000")).toBeInTheDocument();
    expect(screen.getByText('{"customer_tier":"silver"}')).toBeInTheDocument();
    expect(screen.getByText('{"customer_tier":"gold"}')).toBeInTheDocument();
  });

  it("uses distinct explicit confirm and cancel clicks", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ActionProposal
        proposal={proposal}
        now={new Date("2026-07-21T12:00:00.000Z")}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Enter" });
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel update" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm update" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("disables confirmation after expiry", () => {
    const onConfirm = vi.fn();
    render(
      <ActionProposal
        proposal={proposal}
        now={new Date("2026-07-21T12:11:00.000Z")}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );

    const confirm = screen.getByRole("button", { name: "Confirm update" });
    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("expired");
  });

  it("disables confirmation automatically when time expires", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-21T12:00:00.000Z"));
    try {
      render(
        <ActionProposal
          proposal={{
            ...proposal,
            expiresAt: "2026-07-21T12:00:01.000Z",
          }}
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
      const confirm = screen.getByRole("button", { name: "Confirm update" });
      expect(confirm).toBeEnabled();

      act(() => {
        vi.advanceTimersByTime(1_000);
      });

      expect(confirm).toBeDisabled();
      expect(screen.getByRole("status")).toHaveTextContent("expired");
    } finally {
      vi.useRealTimers();
    }
  });

  it("traps keyboard focus between proposal actions", () => {
    render(
      <ActionProposal
        proposal={proposal}
        now={new Date("2026-07-21T12:00:00.000Z")}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const dialog = screen.getByRole("alertdialog");
    const cancel = screen.getByRole("button", { name: "Cancel update" });
    const confirm = screen.getByRole("button", { name: "Confirm update" });

    expect(cancel).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(confirm).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(cancel).toHaveFocus();
  });
});
