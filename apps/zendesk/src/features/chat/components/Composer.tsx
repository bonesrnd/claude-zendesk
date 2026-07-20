import { type KeyboardEvent, useState } from "react";

interface ComposerProps {
  disabled: boolean;
  onSend: (message: string) => void | Promise<void>;
}

export function Composer({ disabled, onSend }: ComposerProps) {
  const [value, setValue] = useState("");

  function submit() {
    const message = value.trim();
    if (!message || disabled) return;
    setValue("");
    void Promise.resolve(onSend(message));
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <div className="composer-shell">
      <label className="sr-only" htmlFor="resolve-composer">
        Ask Słones about this ticket
      </label>
      <textarea
        id="resolve-composer"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        maxLength={20_000}
        rows={1}
        placeholder="Ask about this customer or ticket…"
      />
      <button
        className="send-button"
        type="button"
        onClick={submit}
        disabled={disabled || !value.trim()}
        aria-label="Send message"
      >
        ↑
      </button>
      {disabled && (
        <span className="working-status" role="status">
          Słones is working…
        </span>
      )}
    </div>
  );
}
