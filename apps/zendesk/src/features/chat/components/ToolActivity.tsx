import type { ToolEvent } from "@resolve/contracts";

export function ToolActivity({ events }: { events: ToolEvent[] }) {
  if (events.length === 0) return null;
  return (
    <div className="tool-stack" aria-label="Research activity">
      {events.map((event, index) => (
        <div
          className={`tool-row tool-row--${event.status}`}
          key={`${event.toolName}-${index}`}
        >
          <span className="tool-status" aria-hidden="true">
            {event.status === "succeeded"
              ? "✓"
              : event.status === "failed"
                ? "!"
                : "…"}
          </span>
          <span>{event.summary}</span>
          <span className="sr-only">Status: {event.status}</span>
        </div>
      ))}
    </div>
  );
}
