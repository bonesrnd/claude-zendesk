import "@fontsource-variable/jetbrains-mono";
import { useEffect, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import { ActionProposal } from "../../actions/ActionProposal";
import type { ChatMessage } from "../chat-controller";
import { Conversation } from "./Conversation";
import "../../../styles/tokens.css";
import "../../../styles/app.css";

const longUrl = `https://example.com/${"very-long-path-segment".repeat(30)}`;
const transcript = `Voicemail transcript: ${"callback-request-without-breaks-".repeat(35)}`;
const proposalValue = `customer-profile-value-${"9".repeat(240)}`;
const knowledgeUrl = `https://worker.example/admin/knowledge#document-${"workflow-reference".repeat(20)}`;
const knowledgeLabel =
  `returns.md — Returns > Approval — ${"workflow-reference".repeat(10)}`.slice(
    0,
    200,
  );
const forceRegression = new URLSearchParams(window.parent.location.search).has(
  "regression",
);

function message(
  id: string,
  content: string,
  citations: ChatMessage["citations"] = [],
): ChatMessage {
  return {
    id,
    role: "assistant",
    content,
    createdAt: "2026-07-21T12:00:00.000Z",
    citations,
    toolEvents: [],
  };
}

function BrowserCase({
  name,
  children,
}: {
  name: string;
  children: ReactNode;
}) {
  return <section data-case={name}>{children}</section>;
}

function BrowserHarness() {
  useEffect(() => {
    let cancelled = false;
    void document.fonts.ready.then(() => {
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (!cancelled) {
            document.documentElement.dataset.rendered = "true";
          }
        }),
      );
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main
      className={`containment-harness${forceRegression ? " containment-harness--regression" : ""}`}
    >
      <style>{`
        .containment-harness--regression [data-case="long-url"] {
          width: max-content !important;
          min-width: max-content !important;
          max-width: none !important;
        }
      `}</style>
      <BrowserCase name="long-url">
        <Conversation messages={[message("long-url", longUrl)]} />
      </BrowserCase>
      <BrowserCase name="transcript">
        <Conversation messages={[message("transcript", transcript)]} />
      </BrowserCase>
      <BrowserCase name="proposal">
        <ActionProposal
          proposal={{
            id: "proposal-browser",
            action: "zendesk_update_customer_profile",
            targetId: 77,
            before: { notes: proposalValue },
            changes: { notes: `${proposalValue}-confirmed` },
            expiresAt: "2099-07-21T12:10:00.000Z",
          }}
          onConfirm={() => undefined}
          onCancel={() => undefined}
          now={new Date("2026-07-21T12:00:00.000Z")}
        />
      </BrowserCase>
      <BrowserCase name="knowledge-citation">
        <Conversation
          messages={[
            message("knowledge-citation", "Follow the cited workflow.", [
              {
                provider: "knowledge",
                providerId: "chunk_returns",
                label: knowledgeLabel,
                url: knowledgeUrl,
              },
            ]),
          ]}
        />
      </BrowserCase>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Containment harness root is missing");
createRoot(root).render(<BrowserHarness />);
