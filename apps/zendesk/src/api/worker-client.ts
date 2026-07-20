import {
  ContinueTurnRequestSchema,
  TurnRequestSchema,
  TurnResponseSchema,
  type ContinueTurnRequest,
  type TurnRequest,
  type TurnResponse,
} from "@resolve/contracts";
import { z } from "zod";

import type { ZafClient, ZafRequestOptions } from "../types/zaf";

export interface VisibleSettings {
  workerUrl: string;
  zendeskSubdomain: string;
  anthropicModel: string;
  wooBaseUrl: string;
  shipstationMode: string;
}

const VisibleSettingsSchema = z.object({
  worker_url: z.url(),
  zendesk_subdomain: z.string().min(1),
  anthropic_model: z.string().min(1),
  woo_base_url: z.url(),
  shipstation_mode: z.enum(["v2", "v1", "auto"]),
});

export function parseVisibleSettings(
  settings: Record<string, unknown>,
): VisibleSettings {
  const parsed = VisibleSettingsSchema.parse(settings);
  return {
    workerUrl: parsed.worker_url,
    zendeskSubdomain: parsed.zendesk_subdomain,
    anthropicModel: parsed.anthropic_model,
    wooBaseUrl: parsed.woo_base_url,
    shipstationMode: parsed.shipstation_mode,
  };
}

const ConversationSchema = z.strictObject({
  id: z.string(),
  tenantKey: z.string(),
  ticketId: z.number().int().positive(),
  createdAt: z.string(),
  updatedAt: z.string(),
  expiresAt: z.string(),
});

const StoredMessageSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  agentId: z.number().optional(),
  agentName: z.string().optional(),
  citations: z.array(
    z.strictObject({
      provider: z.enum(["zendesk", "woocommerce", "shipstation"]),
      label: z.string(),
      providerId: z.string(),
      url: z.url(),
    }),
  ),
  toolEvents: z.array(
    z.strictObject({
      skillId: z.string(),
      toolName: z.string(),
      status: z.enum(["running", "succeeded", "failed"]),
      summary: z.string(),
    }),
  ),
  createdAt: z.string(),
});

const ToolRunSchema = z.object({
  id: z.string(),
  skillId: z.string(),
  toolName: z.string(),
  status: z.enum(["running", "succeeded", "failed"]),
  requestSummary: z.unknown(),
  resultSummary: z.unknown().optional(),
  createdAt: z.string(),
});

const SkillsResponseSchema = z.strictObject({
  skills: z.array(
    z.strictObject({
      id: z.string(),
      name: z.string(),
      version: z.string(),
      configured: z.boolean(),
      tools: z.array(
        z.strictObject({
          name: z.string(),
          risk: z.enum(["read", "write"]),
        }),
      ),
    }),
  ),
});

export type SkillStatus = z.infer<
  typeof SkillsResponseSchema
>["skills"][number];

const SECURE_HEADERS = {
  authorization: "Bearer {{setting.backend_auth_token}}",
  "x-resolve-anthropic-key": "{{setting.anthropic_api_key}}",
  "x-resolve-woo-key": "{{setting.woo_consumer_key}}",
  "x-resolve-woo-secret": "{{setting.woo_consumer_secret}}",
  "x-resolve-shipstation-v2-key": "{{setting.shipstation_v2_key}}",
  "x-resolve-shipstation-v1-key": "{{setting.shipstation_v1_key}}",
  "x-resolve-shipstation-v1-secret": "{{setting.shipstation_v1_secret}}",
} as const;

export class WorkerClient {
  private readonly baseUrl: string;

  constructor(
    private readonly client: ZafClient,
    private readonly settings: VisibleSettings,
  ) {
    const url = new URL(settings.workerUrl);
    if (url.protocol !== "https:") {
      throw new Error("Worker URL must use HTTPS");
    }
    this.baseUrl = url.toString().replace(/\/$/, "");
  }

  private headers(): Record<string, string> {
    return {
      ...SECURE_HEADERS,
      "x-resolve-tenant": this.settings.zendeskSubdomain,
      "x-resolve-anthropic-model": this.settings.anthropicModel,
      "x-resolve-woo-url": this.settings.wooBaseUrl,
      "x-resolve-shipstation-mode": this.settings.shipstationMode,
    };
  }

  private async request<T>(
    path: string,
    schema: z.ZodType<T>,
    options: { method?: "GET" | "POST"; body?: unknown } = {},
  ): Promise<T> {
    const requestOptions: ZafRequestOptions = {
      url: `${this.baseUrl}${path}`,
      type: options.method ?? "GET",
      headers: this.headers(),
      secure: true,
      cors: false,
      timeout: 60_000,
      dataType: "json",
      ...(options.body === undefined
        ? {}
        : {
            contentType: "application/json",
            data: JSON.stringify(options.body),
          }),
    };
    return schema.parse(await this.client.request(requestOptions));
  }

  startTurn(input: TurnRequest): Promise<TurnResponse> {
    return this.request("/v1/turn", TurnResponseSchema, {
      method: "POST",
      body: TurnRequestSchema.parse(input),
    });
  }

  continueTurn(input: ContinueTurnRequest): Promise<TurnResponse> {
    return this.request("/v1/turn/continue", TurnResponseSchema, {
      method: "POST",
      body: ContinueTurnRequestSchema.parse(input),
    });
  }

  listConversations(ticketId: number) {
    return this.request(
      `/v1/tickets/${ticketId}/conversations`,
      z.strictObject({ conversations: z.array(ConversationSchema) }),
    );
  }

  getConversation(conversationId: string) {
    return this.request(
      `/v1/conversations/${encodeURIComponent(conversationId)}/messages`,
      z.strictObject({
        conversation: ConversationSchema,
        messages: z.array(StoredMessageSchema),
        toolRuns: z.array(ToolRunSchema),
      }),
    );
  }

  listSkills(): Promise<{ skills: SkillStatus[] }> {
    return this.request("/v1/skills", SkillsResponseSchema);
  }

  checkSkill(skillId: string, ticketId: number) {
    return this.request(
      `/v1/skills/${encodeURIComponent(skillId)}/health`,
      z.strictObject({
        id: z.string(),
        ok: z.boolean(),
        message: z.string(),
      }),
      { method: "POST", body: { ticketId } },
    );
  }
}
