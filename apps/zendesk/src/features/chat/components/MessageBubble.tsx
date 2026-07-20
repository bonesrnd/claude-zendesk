import type { ChatMessage } from "../chat-controller";
import { CitationLink } from "./CitationLink";
import { ToolActivity } from "./ToolActivity";

export function MessageBubble({ message }: { message: ChatMessage }) {
  return (
    <article className={`message message--${message.role}`}>
      {message.role === "assistant" && (
        <ToolActivity events={message.toolEvents} />
      )}
      <div className="message-bubble">{message.content}</div>
      {message.citations.length > 0 && (
        <div className="citation-list" aria-label="Sources">
          {message.citations.map((citation) => (
            <CitationLink
              citation={citation}
              key={`${citation.provider}:${citation.providerId}`}
            />
          ))}
        </div>
      )}
    </article>
  );
}
