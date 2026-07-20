import {
  AgentIdentitySchema,
  TicketContextSchema,
  type AgentIdentity,
  type TicketContext,
} from "@resolve/contracts";
import { z } from "zod";

import type { ZafClient } from "../../types/zaf";

const RequesterSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1),
  email: z.string().nullable().optional(),
});

const BrandSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1),
  subdomain: z.string().nullable().optional(),
});

const UserSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1),
});

const ConversationEntrySchema = z.object({
  author: z
    .object({
      name: z.string().optional(),
    })
    .optional(),
  message: z
    .object({
      content: z.string().nullable().optional(),
    })
    .optional(),
  timestamp: z.string(),
  public: z.boolean().optional().default(true),
});

export interface ActiveTicketContext {
  ticket: TicketContext;
  agent: AgentIdentity;
}

export async function getTicketContext(
  client: ZafClient,
): Promise<ActiveTicketContext> {
  const result = await client.get([
    "ticket.id",
    "ticket.subject",
    "ticket.requester",
    "ticket.brand",
    "ticket.conversation",
    "currentUser",
  ]);
  const requester = RequesterSchema.parse(result["ticket.requester"]);
  const brand = BrandSchema.parse(result["ticket.brand"]);
  const user = UserSchema.parse(result.currentUser);
  const conversation = z
    .array(ConversationEntrySchema)
    .parse(result["ticket.conversation"] ?? [])
    .slice(-30)
    .map((entry) => ({
      authorName: (entry.author?.name ?? "Unknown").slice(0, 200),
      body: (entry.message?.content ?? "").slice(0, 20_000),
      createdAt: new Date(entry.timestamp).toISOString(),
      public: entry.public,
    }));

  return {
    ticket: TicketContextSchema.parse({
      ticketId: result["ticket.id"],
      subject:
        typeof result["ticket.subject"] === "string"
          ? result["ticket.subject"]
          : "",
      requester: {
        id: requester.id,
        name: requester.name,
        ...(requester.email ? { email: requester.email } : {}),
      },
      brand: {
        id: brand.id,
        name: brand.name,
        ...(brand.subdomain ? { subdomain: brand.subdomain } : {}),
      },
      recentConversation: conversation,
    }),
    agent: AgentIdentitySchema.parse(user),
  };
}
