import type { AnthropicEffort } from "@resolve/contracts";

interface AssistantSettingsProps {
  model: string;
  effort: AnthropicEffort;
}

export function AssistantSettings({ model, effort }: AssistantSettingsProps) {
  const effortLabel = effort.slice(0, 1).toUpperCase() + effort.slice(1);

  return (
    <section className="assistant-settings">
      <div className="view-heading">
        <span className="eyebrow">Słones configuration</span>
        <h2>Assistant settings</h2>
        <p>These team-wide values are controlled by Zendesk administrators.</p>
      </div>
      <dl className="settings-list">
        <div>
          <dt>Claude model</dt>
          <dd>{model}</dd>
        </div>
        <div>
          <dt>Effort</dt>
          <dd>{effortLabel}</dd>
        </div>
      </dl>
      <div className="settings-help">
        To swap the model or adjust effort, open Zendesk Admin Center, then go
        to Apps and integrations → Zendesk Support apps → Resolve.
      </div>
    </section>
  );
}
