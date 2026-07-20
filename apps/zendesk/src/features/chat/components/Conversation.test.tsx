import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ChatMessage } from "../chat-controller";
import { Conversation } from "./Conversation";

const messages: ChatMessage[] = [
  {
    id: "local_1",
    role: "user",
    content: "Where is the order?",
    createdAt: "2026-07-18T12:00:00.000Z",
    citations: [],
    toolEvents: [],
  },
  {
    id: "msg_2",
    role: "assistant",
    content: "It shipped yesterday.",
    createdAt: "2026-07-18T12:00:01.000Z",
    citations: [
      {
        provider: "woocommerce",
        label: "WooCommerce order 10982",
        providerId: "10982",
        url: "https://store.example/orders/10982",
      },
    ],
    toolEvents: [
      {
        skillId: "woocommerce",
        toolName: "woocommerce_get_order",
        status: "succeeded",
        summary: "WooCommerce lookup completed.",
      },
    ],
  },
];

describe("Conversation", () => {
  it("announces messages and renders verifiable sources", () => {
    render(<Conversation messages={messages} />);

    expect(screen.getByRole("log")).toHaveAttribute("aria-live", "polite");
    expect(screen.getByText("It shipped yesterday.")).toBeInTheDocument();
    expect(
      screen.getByText("WooCommerce lookup completed."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "WooCommerce order 10982" }),
    ).toHaveAttribute("rel", "noreferrer");
  });

  it("renders an accessible empty state", () => {
    render(<Conversation messages={[]} />);

    expect(
      screen.getByText("Research this ticket without leaving Zendesk."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Ask Słones about the customer/i),
    ).toBeInTheDocument();
  });
});
