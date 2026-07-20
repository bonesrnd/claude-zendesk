import type { Citation } from "@resolve/contracts";

export function CitationLink({ citation }: { citation: Citation }) {
  return (
    <a
      className="citation"
      href={citation.url}
      target="_blank"
      rel="noreferrer"
    >
      {citation.label}
    </a>
  );
}
