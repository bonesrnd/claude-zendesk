import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const componentDirectory = path.resolve(
  process.cwd(),
  "src/features/chat/components",
);
const fixturePath = path.join(componentDirectory, "Conversation.browser.html");
const framePath = path.join(
  componentDirectory,
  "Conversation.browser.frame.html",
);
const entryPath = path.join(componentDirectory, "Conversation.browser.tsx");

describe("Conversation browser harness", () => {
  it("renders production conversation, proposal, and citation DOM", async () => {
    const fixture = await readFile(fixturePath, "utf8");

    expect(fixture).toContain("Conversation.browser.frame.html");

    const frame = await readFile(framePath, "utf8");
    expect(frame).toContain("Conversation.browser.tsx");

    const entry = await readFile(entryPath, "utf8");
    expect(entry).toContain('import { ActionProposal } from "../../actions/');
    expect(entry).toContain('import { Conversation } from "./Conversation"');
    expect(entry).toContain('import "../../../styles/tokens.css"');
    expect(entry).toContain('import "../../../styles/app.css"');
  });

  it("checks the complete 320px root and keeps named regression cases", async () => {
    const fixture = await readFile(fixturePath, "utf8");
    const entry = await readFile(entryPath, "utf8");

    expect(fixture).toContain('"#root, #root *"');
    expect(entry).toContain('name="long-url"');
    expect(entry).toContain('name="transcript"');
    expect(entry).toContain('name="proposal"');
    expect(entry).toContain('name="knowledge-citation"');
    expect(entry).toContain("containment-harness--regression");
  });
});
