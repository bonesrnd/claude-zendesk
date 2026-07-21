import { parseMarkdown } from "./markdown";

export const KNOWLEDGE_TARGET_TOKENS = 800;
export const KNOWLEDGE_OVERLAP_TOKENS = 100;

const APPROXIMATE_CHARACTERS_PER_TOKEN = 4;
const TARGET_CHARACTERS =
  KNOWLEDGE_TARGET_TOKENS * APPROXIMATE_CHARACTERS_PER_TOKEN;
const OVERLAP_CHARACTERS =
  KNOWLEDGE_OVERLAP_TOKENS * APPROXIMATE_CHARACTERS_PER_TOKEN;
const MINIMUM_BOUNDARY_WINDOW = 200;

export interface MarkdownChunk {
  filename: string;
  headingPath: string[];
  ordinal: number;
  content: string;
}

function boundaryAtOrBefore(content: string, desired: number): number {
  const minimum = Math.max(0, desired - MINIMUM_BOUNDARY_WINDOW);
  for (let index = desired; index >= minimum; index -= 1) {
    if (/\s/u.test(content[index] ?? "")) return index;
  }
  return desired;
}

function splitSection(content: string): string[] {
  if (content.length <= TARGET_CHARACTERS) return [content];

  const chunks: string[] = [];
  let start = 0;
  while (start < content.length) {
    const desiredEnd = Math.min(start + TARGET_CHARACTERS, content.length);
    const end =
      desiredEnd === content.length
        ? desiredEnd
        : boundaryAtOrBefore(content, desiredEnd);
    const chunk = content.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= content.length) break;
    start = Math.max(start + 1, end - OVERLAP_CHARACTERS);
  }
  return chunks;
}

export function chunkMarkdown(
  filename: string,
  markdown: string,
): MarkdownChunk[] {
  const parsed = parseMarkdown(markdown);
  let ordinal = 0;
  return parsed.sections.flatMap((section) =>
    splitSection(section.content).map((content) => ({
      filename,
      headingPath: [...section.headingPath],
      ordinal: ordinal++,
      content,
    })),
  );
}
