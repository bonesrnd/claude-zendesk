import type { AnthropicEffort } from "@resolve/contracts";

interface AssistantSettingsProps {
  model: string;
  effort: AnthropicEffort;
  workerUrl: string;
  workerHost: string;
  zendeskSubdomain: string;
}

export function AssistantSettings({
  model,
  effort,
  workerUrl,
  workerHost,
  zendeskSubdomain,
}: AssistantSettingsProps) {
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
        <div>
          <dt>Worker URL</dt>
          <dd>{workerUrl}</dd>
        </div>
        <div>
          <dt>Worker hostname</dt>
          <dd>{workerHost}</dd>
        </div>
        <div>
          <dt>Zendesk subdomain</dt>
          <dd>{zendeskSubdomain}</dd>
        </div>
      </dl>
      <div className="settings-help">
        To swap the model or adjust effort, open Zendesk Admin Center, then go
        to Apps and integrations → Zendesk Support apps → Resolve.
      </div>
    </section>
  );
}
