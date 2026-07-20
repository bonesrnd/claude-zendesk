export function EmptyState() {
  return (
    <section className="empty-state">
      <span className="empty-state-mark" aria-hidden="true">
        S
      </span>
      <h2>Research this ticket without leaving Zendesk.</h2>
      <p>
        Ask Słones about the customer, recent orders, tracking, or how similar
        tickets were resolved.
      </p>
      <div className="prompt-examples" aria-label="Example questions">
        <span>Where is the latest order?</span>
        <span>How did we resolve this before?</span>
        <span>Show recent shipment details.</span>
      </div>
    </section>
  );
}
