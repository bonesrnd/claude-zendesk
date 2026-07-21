import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ChatMessage } from "../chat-controller";
import { Conversation } from "./Conversation";

const appCss = readFileSync(
  resolve(process.cwd(), "src/styles/app.css"),
  "utf8",
);

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

  it("applies containment styles to long assistant content", () => {
    const longMessages: ChatMessage[] = [
      "x".repeat(300),
      `https://example.com/${"very-long-path-segment".repeat(30)}`,
      `Inline code: \`${"token".repeat(80)}\``,
      `\`\`\`\n${"unbroken-code".repeat(80)}\n\`\`\``,
      `Column A | Column B\n${"table-cell".repeat(60)} | value`,
    ].map((content, index) => ({
      id: `overflow_${index}`,
      role: "assistant",
      content,
      createdAt: `2026-07-18T12:00:0${index}.000Z`,
      citations: [],
      toolEvents: [],
    }));
    document.documentElement.style.width = "320px";
    document.body.style.width = "320px";
    const stylesheet = document.createElement("style");
    stylesheet.textContent = appCss;
    document.head.append(stylesheet);

    const { container } = render(<Conversation messages={longMessages} />);

    const messagesAndBubbles = container.querySelectorAll(
      ".message, .message-bubble",
    );
    expect(messagesAndBubbles).toHaveLength(10);
    for (const element of messagesAndBubbles) {
      expect(getComputedStyle(element).minWidth).toBe("0px");
    }
    for (const bubble of container.querySelectorAll(".message-bubble")) {
      const textContainers = [bubble, ...bubble.querySelectorAll("*")];
      for (const element of textContainers) {
        const style = getComputedStyle(element);
        expect(style.overflowWrap).toBe("anywhere");
        expect(style.wordBreak).toBe("break-word");
      }
    }
    const bubble = container.querySelector(".message-bubble");
    expect(bubble).not.toBeNull();
    for (const tagName of ["pre", "table"]) {
      const element = document.createElement(tagName);
      bubble?.append(element);
      const style = getComputedStyle(element);
      expect(style.maxWidth).toBe("100%");
      expect(style.overflowX).toBe("auto");
    }
    stylesheet.remove();
  });
});
