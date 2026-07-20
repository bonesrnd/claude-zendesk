import type {
  Citation,
  ContinueTurnRequest,
  DelegatedToolResponse,
  ToolEvent,
  TurnRequest,
  TurnResponse,
} from "@resolve/contracts";

import type { WorkerClient } from "../../api/worker-client";
import type { DelegatedToolResult } from "../zendesk-tools/executor";
import type { ActiveTicketContext } from "../ticket/ticket-context";

export type ChatWorker = Pick<
  WorkerClient,
  "startTurn" | "continueTurn" | "listConversations" | "getConversation"
>;

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  citations: Citation[];
  toolEvents: ToolEvent[];
}

type ConversationList = Awaited<
  ReturnType<ChatWorker["listConversations"]>
>["conversations"];

export interface ChatError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface ChatState {
  status: "loading_history" | "ready" | "submitting" | "error";
  messages: ChatMessage[];
  conversations: ConversationList;
  activeConversationId: string | undefined;
  error: ChatError | undefined;
}

interface ChatControllerOptions {
  worker: ChatWorker;
  executeZendeskTool: (
    request: DelegatedToolResponse["requests"][number],
  ) => Promise<DelegatedToolResult>;
  now?: () => Date;
}

export class ChatController {
  private state: ChatState = {
    status: "ready",
    messages: [],
    conversations: [],
    activeConversationId: undefined,
    error: undefined,
  };
  private readonly listeners = new Set<() => void>();
  private readonly now: () => Date;

  constructor(private readonly options: ChatControllerOptions) {
    this.now = options.now ?? (() => new Date());
  }

  getSnapshot = (): ChatState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private update(state: ChatState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }

  async loadHistory(ticketId: number): Promise<void> {
    this.update({ ...this.state, status: "loading_history" });
    try {
      const { conversations } =
        await this.options.worker.listConversations(ticketId);
      this.update({
        ...this.state,
        conversations,
        status: "ready",
      });
      const newest = conversations[0];
      if (newest) await this.openConversation(newest.id);
    } catch {
      this.fail(
        "history_unavailable",
        "Saved conversations could not be loaded.",
        true,
      );
    }
  }

  async openConversation(conversationId: string): Promise<void> {
    try {
      const result = await this.options.worker.getConversation(conversationId);
      this.update({
        ...this.state,
        status: "ready",
        activeConversationId: result.conversation.id,
        messages: result.messages.map((message) => ({
          id: message.id,
          role: message.role,
          content: message.content,
          createdAt: message.createdAt,
          citations: message.citations,
          toolEvents: message.toolEvents,
        })),
      });
    } catch {
      this.fail(
        "history_unavailable",
        "This conversation could not be loaded.",
        true,
      );
    }
  }

  newConversation(): void {
    this.update({
      status: "ready",
      messages: [],
      conversations: this.state.conversations,
      activeConversationId: undefined,
      error: undefined,
    });
  }

  async send(content: string, context: ActiveTicketContext): Promise<void> {
    const message = content.trim();
    if (!message || this.state.status === "submitting") return;

    const localMessage: ChatMessage = {
      id: `local_${crypto.randomUUID()}`,
      role: "user",
      content: message,
      createdAt: this.now().toISOString(),
      citations: [],
      toolEvents: [],
    };
    this.update({
      ...this.state,
      status: "submitting",
      messages: [...this.state.messages, localMessage],
      error: undefined,
    });

    try {
      const request: TurnRequest = {
        ...(this.state.activeConversationId
          ? { conversationId: this.state.activeConversationId }
          : {}),
        message,
        ticket: context.ticket,
        agent: context.agent,
      };
      let response = await this.options.worker.startTurn(request);
      for (let delegatedCount = 0; ; delegatedCount += 1) {
        if (response.kind !== "delegated_tool_request") break;
        if (delegatedCount >= 6) {
          this.fail(
            "orchestration_limit",
            "Słones reached the delegated tool limit.",
            true,
          );
          return;
        }
        const results = await Promise.all(
          response.requests.map(async (delegated) => {
            try {
              return await this.options.executeZendeskTool(delegated);
            } catch {
              return {
                toolUseId: delegated.toolUseId,
                toolName: delegated.toolName,
                output: { error: "zendesk_tool_failed" },
                isError: true,
              };
            }
          }),
        );
        const continuation: ContinueTurnRequest = {
          turnId: response.turnId,
          results,
        };
        response = await this.options.worker.continueTurn(continuation);
      }
      this.applyResponse(response);
    } catch {
      this.fail(
        "request_failed",
        "Słones could not complete this request.",
        true,
      );
    }
  }

  private applyResponse(response: TurnResponse): void {
    if (response.kind === "error") {
      if (response.partial) {
        this.update({
          ...this.state,
          activeConversationId: response.partial.conversationId,
          messages: [
            ...this.state.messages,
            {
              id: response.partial.messageId,
              role: "assistant",
              content: response.partial.content,
              createdAt: this.now().toISOString(),
              citations: response.partial.citations,
              toolEvents: response.partial.toolEvents,
            },
          ],
        });
      }
      this.fail(response.code, response.message, response.retryable);
      return;
    }
    if (response.kind === "delegated_tool_request") {
      this.fail(
        "orchestration_limit",
        "Słones reached the delegated tool limit.",
        true,
      );
      return;
    }
    const assistant: ChatMessage = {
      id: response.messageId,
      role: "assistant",
      content: response.content,
      createdAt: this.now().toISOString(),
      citations: response.citations,
      toolEvents: response.toolEvents,
    };
    this.update({
      ...this.state,
      status: "ready",
      activeConversationId: response.conversationId,
      messages: [...this.state.messages, assistant],
      error: undefined,
    });
  }

  private fail(code: string, message: string, retryable: boolean): void {
    this.update({
      ...this.state,
      status: "error",
      error: { code, message, retryable },
    });
  }
}
