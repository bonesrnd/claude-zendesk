import type { ChatError } from "../chat-controller";

export function ErrorNotice({ error }: { error: ChatError }) {
  return (
    <div className="error-notice" role="alert">
      <strong>Słones could not finish.</strong>
      <span>{error.message}</span>
    </div>
  );
}
