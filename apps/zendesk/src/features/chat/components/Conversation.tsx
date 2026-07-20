import type { ChatMessage } from "../chat-controller";
import { EmptyState } from "./EmptyState";
import { MessageBubble } from "./MessageBubble";

export function Conversation({ messages }: { messages: ChatMessage[] }) {
  return (
    <div className="conversation" role="log" aria-live="polite">
      {messages.length === 0 ? (
        <EmptyState />
      ) : (
        messages.map((message) => (
          <MessageBubble key={message.id} message={message} />
        ))
      )}
    </div>
  );
}
