import type { WriteProposal } from "@resolve/contracts";
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

interface ActionProposalProps {
  proposal: WriteProposal;
  onConfirm: () => void;
  onCancel: () => void;
  now?: Date;
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "(empty)";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value) ?? "(unavailable)";
}

export function ActionProposal({
  proposal,
  onConfirm,
  onCancel,
  now = new Date(),
}: ActionProposalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const expiresAt = new Date(proposal.expiresAt).getTime();
  const [currentTime, setCurrentTime] = useState(now.getTime());
  const expired = expiresAt <= currentTime || Number.isNaN(expiresAt);
  const isTicket = proposal.action === "zendesk_update_ticket_custom_fields";
  const targetLabel = isTicket
    ? `Ticket ${proposal.targetId}`
    : `Customer profile ${proposal.targetId}`;
  const title = isTicket
    ? "Confirm ticket custom-field update"
    : "Confirm customer profile update";
  const changeSummary = Object.keys(proposal.changes)
    .map(
      (field) =>
        `${field} changes from ${displayValue(proposal.before[field])} to ${displayValue(proposal.changes[field])}`,
    )
    .join(". ");

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  useEffect(() => {
    const remaining = expiresAt - currentTime;
    if (!Number.isFinite(remaining) || remaining <= 0) return;
    const timer = window.setTimeout(() => {
      setCurrentTime(expiresAt);
    }, remaining);
    return () => window.clearTimeout(timer);
  }, [currentTime, expiresAt]);

  function trapFocus(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Enter" && event.target === dialogRef.current) {
      event.preventDefault();
      return;
    }
    if (event.key !== "Tab") return;
    const actions = [
      cancelRef.current,
      expired ? null : confirmRef.current,
    ].filter((element): element is HTMLButtonElement => element !== null);
    if (actions.length === 0) return;
    const current = document.activeElement;
    const index = actions.indexOf(current as HTMLButtonElement);
    if (
      event.shiftKey &&
      (index <= 0 || !actions.includes(current as HTMLButtonElement))
    ) {
      event.preventDefault();
      actions.at(-1)?.focus();
    } else if (!event.shiftKey && index === actions.length - 1) {
      event.preventDefault();
      actions[0]?.focus();
    }
  }

  return (
    <div
      ref={dialogRef}
      className="action-proposal"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={`proposal-title-${proposal.id}`}
      aria-describedby={`proposal-description-${proposal.id}`}
      onKeyDown={trapFocus}
    >
      <div className="action-proposal-heading">
        <span className="eyebrow">Confirmation required</span>
        <h2 id={`proposal-title-${proposal.id}`}>{title}</h2>
      </div>
      <p id={`proposal-description-${proposal.id}`} className="sr-only">
        {targetLabel}. {changeSummary}.
      </p>
      <p className="action-target">{targetLabel}</p>
      <div className="action-changes">
        {Object.entries(proposal.changes).map(([field, after]) => (
          <div className="action-change" key={field}>
            <strong>{field}</strong>
            <div>
              <span>Before</span>
              <code>{displayValue(proposal.before[field])}</code>
            </div>
            <div>
              <span>After</span>
              <code>{displayValue(after)}</code>
            </div>
          </div>
        ))}
      </div>
      {expired && (
        <p className="action-expired" role="status">
          This proposal has expired. Ask Słones to create a new one.
        </p>
      )}
      <div className="action-buttons">
        <button ref={cancelRef} type="button" onClick={onCancel}>
          Cancel update
        </button>
        <button
          ref={confirmRef}
          type="button"
          className="confirm-action"
          disabled={expired}
          onClick={onConfirm}
        >
          Confirm update
        </button>
      </div>
    </div>
  );
}
