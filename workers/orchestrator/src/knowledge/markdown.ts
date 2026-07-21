export interface MarkdownSection {
  headingPath: string[];
  content: string;
}

export interface ParsedMarkdown {
  frontMatter: Record<string, unknown>;
  sections: MarkdownSection[];
}

const SAFE_FRONT_MATTER_KEY = /^[A-Za-z][A-Za-z0-9_-]*$/u;

function scalarValue(raw: string): unknown {
  const value = raw.trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    const content = value.slice(1, -1);
    return value.startsWith('"')
      ? JSON.parse(value)
      : content.replaceAll("''", "'");
  }
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null" || value === "~") return null;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) return Number(value);
  return value.replace(/\s+#.*$/u, "").trim();
}

function readFrontMatter(markdown: string): {
  body: string;
  frontMatter: Record<string, unknown>;
} {
  const normalized = markdown.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  if (!normalized.startsWith("---\n")) {
    return { body: normalized, frontMatter: {} };
  }
  const closing = normalized.indexOf("\n---\n", 4);
  if (closing === -1) return { body: normalized, frontMatter: {} };

  const frontMatter: Record<string, unknown> = {};
  const source = normalized.slice(4, closing);
  for (const line of source.split("\n")) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (
      !SAFE_FRONT_MATTER_KEY.test(key) ||
      key === "__proto__" ||
      key === "constructor" ||
      key === "prototype"
    ) {
      continue;
    }
    try {
      frontMatter[key] = scalarValue(line.slice(separator + 1));
    } catch {
      frontMatter[key] = line.slice(separator + 1).trim();
    }
  }
  return {
    body: normalized.slice(closing + "\n---\n".length),
    frontMatter,
  };
}

export function parseMarkdown(markdown: string): ParsedMarkdown {
  const { body, frontMatter } = readFrontMatter(markdown);
  const sections: MarkdownSection[] = [];
  const headingPath: string[] = [];
  let currentLines: string[] = [];
  let currentPath: string[] = [];
  let fence: string | undefined;

  const flush = (): void => {
    const content = currentLines.join("\n").trim();
    if (content) {
      sections.push({ headingPath: [...currentPath], content });
    }
    currentLines = [];
  };

  for (const line of body.split("\n")) {
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/u);
    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      if (!fence) fence = marker[0];
      else if (marker[0] === fence) fence = undefined;
      currentLines.push(line);
      continue;
    }

    const heading = fence
      ? undefined
      : line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/u);
    if (!heading) {
      currentLines.push(line);
      continue;
    }

    flush();
    const depth = heading[1]!.length;
    const title = heading[2]!.trim();
    headingPath.splice(depth - 1);
    headingPath[depth - 1] = title;
    currentPath = headingPath.filter((part): part is string => Boolean(part));
  }
  flush();

  return { frontMatter, sections };
}
