import { useEffect, useState, useSyncExternalStore } from "react";

import {
  parseVisibleSettings,
  WorkerClient,
  type VisibleSettings,
} from "../api/worker-client";
import {
  ChatController,
  type ChatState,
} from "../features/chat/chat-controller";
import { ActionProposal } from "../features/actions/ActionProposal";
import { Composer } from "../features/chat/components/Composer";
import { Conversation } from "../features/chat/components/Conversation";
import { ErrorNotice } from "../features/chat/components/ErrorNotice";
import { AssistantSettings } from "../features/settings/AssistantSettings";
import { SkillsManager } from "../features/skills/SkillsManager";
import {
  getTicketContext,
  type ActiveTicketContext,
} from "../features/ticket/ticket-context";
import {
  executeConfirmedZendeskAction,
  executeZendeskTool,
  inspectZendeskProposal,
} from "../features/zendesk-tools/executor";
import { useZafClient } from "./ZafClientProvider";

type View = "chat" | "history" | "skills" | "settings";

interface ReadyApp {
  context: ActiveTicketContext;
  worker: WorkerClient;
  controller: ChatController;
  settings: VisibleSettings;
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.slice(0, 1))
    .join("")
    .toUpperCase();
}

function Workspace({ ready }: { ready: ReadyApp }) {
  const [view, setView] = useState<View>("chat");
  const state = useSyncExternalStore(
    ready.controller.subscribe,
    ready.controller.getSnapshot,
    ready.controller.getSnapshot,
  );
  const busy =
    state.status === "submitting" ||
    state.status === "confirming" ||
    state.status === "loading_history" ||
    Boolean(state.proposal);

  async function send(message: string) {
    await ready.controller.send(message, ready.context);
  }

  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            S
          </span>
          <h1>Słones</h1>
        </div>
        <nav aria-label="Słones views">
          <button
            type="button"
            className={view === "history" ? "is-active" : ""}
            onClick={() => setView("history")}
          >
            History
          </button>
          <button
            type="button"
            className={view === "skills" ? "is-active" : ""}
            onClick={() => setView("skills")}
          >
            Skills
          </button>
          <button
            type="button"
            className={view === "settings" ? "is-active" : ""}
            onClick={() => setView("settings")}
          >
            Settings
          </button>
          <button
            type="button"
            className="new-chat"
            onClick={() => {
              ready.controller.newConversation();
              setView("chat");
            }}
          >
            New
          </button>
        </nav>
      </header>

      <section className="ticket-context" aria-label="Active ticket">
        <span className="customer-avatar" aria-hidden="true">
          {initials(ready.context.ticket.requester.name)}
        </span>
        <div>
          <strong>{ready.context.ticket.requester.name}</strong>
          <span>
            {ready.context.ticket.requester.email ?? "No requester email"}
          </span>
        </div>
        <span className="ticket-pill">#{ready.context.ticket.ticketId}</span>
      </section>

      {view === "chat" && (
        <div className="chat-view">
          <Conversation messages={state.messages} />
          {state.proposal && (
            <ActionProposal
              proposal={state.proposal}
              onConfirm={() => {
                void ready.controller.confirmAction();
              }}
              onCancel={() => ready.controller.cancelAction()}
            />
          )}
          {state.error && <ErrorNotice error={state.error} />}
          <Composer disabled={busy} onSend={send} />
        </div>
      )}

      {view === "history" && (
        <HistoryView
          state={state}
          onOpen={(conversationId) => {
            void ready.controller.openConversation(conversationId);
            setView("chat");
          }}
        />
      )}

      {view === "skills" && (
        <SkillsManager
          worker={ready.worker}
          ticketId={ready.context.ticket.ticketId}
          brand={ready.context.ticket.brand}
        />
      )}

      {view === "settings" && (
        <AssistantSettings
          model={ready.settings.anthropicModel}
          effort={ready.settings.anthropicEffort}
          workerUrl={ready.settings.workerUrl}
          workerHost={ready.settings.workerHost}
          zendeskSubdomain={ready.settings.zendeskSubdomain}
        />
      )}
    </main>
  );
}

function HistoryView({
  state,
  onOpen,
}: {
  state: ChatState;
  onOpen: (conversationId: string) => void;
}) {
  return (
    <section className="history-view">
      <div className="view-heading">
        <span className="eyebrow">Ticket continuity</span>
        <h2>Conversation history</h2>
        <p>Retained for 90 days and shared with this ticket's agents.</p>
      </div>
      {state.conversations.length === 0 ? (
        <p className="quiet-note">No saved Słones conversations yet.</p>
      ) : (
        <div className="history-list">
          {state.conversations.map((conversation) => (
            <button
              type="button"
              onClick={() => onOpen(conversation.id)}
              key={conversation.id}
            >
              <span>{new Date(conversation.updatedAt).toLocaleString()}</span>
              <strong>Ticket #{conversation.ticketId}</strong>
              <small>
                Available until{" "}
                {new Date(conversation.expiresAt).toLocaleDateString()}
              </small>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

export function App() {
  const client = useZafClient();
  const [ready, setReady] = useState<ReadyApp>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    void (async () => {
      let settings: VisibleSettings;
      try {
        const metadata = await client.metadata();
        settings = parseVisibleSettings(metadata.settings);
      } catch {
        if (active) {
          setError("Resolve settings are incomplete or invalid.");
        }
        return;
      }

      let context: ActiveTicketContext;
      try {
        context = await getTicketContext(client);
      } catch {
        if (active) {
          setError("Zendesk ticket context is unavailable.");
        }
        return;
      }

      try {
        const worker = new WorkerClient(client, settings);
        const controller = new ChatController({
          worker,
          executeZendeskTool: (request) =>
            executeZendeskTool(client, request, settings.zendeskSubdomain),
          inspectZendeskProposal: (proposal) =>
            inspectZendeskProposal(client, proposal),
          executeConfirmedZendeskAction: (request) =>
            executeConfirmedZendeskAction(
              client,
              request,
              settings.zendeskSubdomain,
            ),
        });
        await controller.loadHistory(context.ticket.ticketId);
        if (active) setReady({ context, worker, controller, settings });
      } catch {
        if (active) {
          setError(
            "Resolve could not connect to its Worker. Check the backend token and reload.",
          );
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [client]);

  if (error) {
    return (
      <main className="bootstrap-state">
        <h1>Słones</h1>
        <div className="error-notice" role="alert">
          {error}
        </div>
      </main>
    );
  }

  if (!ready) {
    return (
      <main className="bootstrap-state" aria-busy="true">
        <span className="brand-mark" aria-hidden="true">
          S
        </span>
        <h1>Słones</h1>
        <p>Reading ticket context…</p>
      </main>
    );
  }

  return <Workspace ready={ready} />;
}
