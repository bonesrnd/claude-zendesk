import { describe, expect, it } from "vitest";

import { chunkMarkdown } from "./chunk";
import { parseMarkdown } from "./markdown";

const longSection = Array.from(
  { length: 900 },
  (_, index) => `workflow-step-${index.toString().padStart(4, "0")}`,
).join(" ");

const syntheticMarkdown = `---
brand: Solution Peptides
workflow_category: returns
published: true
---
# Returns

Use this workflow for approved returns.

## Eligibility

- Confirm the order date.
- Confirm the product is unopened.

\`\`\`text
# This is code, not a heading
refund --order 123
\`\`\`

## Long procedure

${longSection}
`;

describe("parseMarkdown", () => {
  it("parses front matter and stable heading paths without treating fences as headings", () => {
    const parsed = parseMarkdown(syntheticMarkdown);

    expect(parsed.frontMatter).toMatchObject({
      brand: "Solution Peptides",
      workflow_category: "returns",
      published: true,
    });
    expect(parsed.sections.map((section) => section.headingPath)).toEqual([
      ["Returns"],
      ["Returns", "Eligibility"],
      ["Returns", "Long procedure"],
    ]);
    expect(parsed.sections[1]?.content).toContain(
      "# This is code, not a heading",
    );
    expect(parsed.sections[1]?.content).toContain(
      "- Confirm the product is unopened.",
    );
  });
});

describe("chunkMarkdown", () => {
  it("creates ordered, approximately 800-token chunks with overlap", () => {
    const chunks = chunkMarkdown("returns.md", syntheticMarkdown);
    const longChunks = chunks.filter(
      (chunk) => chunk.headingPath.join(" > ") === "Returns > Long procedure",
    );

    expect(chunks.map((chunk) => chunk.ordinal)).toEqual(
      chunks.map((_, index) => index),
    );
    expect(longChunks.length).toBeGreaterThan(1);
    expect(longChunks.every((chunk) => chunk.content.length <= 3_700)).toBe(
      true,
    );
    const priorTail = longChunks[0]?.content.slice(-250);
    expect(priorTail).toBeTruthy();
    expect(longChunks[1]?.content).toContain(priorTail);
    expect(chunks.every((chunk) => chunk.filename === "returns.md")).toBe(true);
    expect(chunks.some((chunk) => chunk.content.includes("brand:"))).toBe(
      false,
    );
  });

  it("keeps a fenced code block and list content intact", () => {
    const chunks = chunkMarkdown("returns.md", syntheticMarkdown);
    const eligibility = chunks.find(
      (chunk) => chunk.headingPath.at(-1) === "Eligibility",
    );

    expect(eligibility?.content).toContain("```text");
    expect(eligibility?.content).toContain("refund --order 123");
    expect(eligibility?.content).toContain("- Confirm the order date.");
  });
});
