import type { DelegatedToolResponse, WriteProposal } from "@resolve/contracts";
import { describe, expect, it, vi } from "vitest";

import type { ZafClient } from "../../types/zaf";
import {
  executeConfirmedZendeskAction,
  executeZendeskTool,
  inspectZendeskProposal,
} from "./executor";

type DelegatedRequest = DelegatedToolResponse["requests"][number];

function request(toolName: string, input: unknown): DelegatedRequest {
  return {
    toolUseId: "tool_1",
    toolName,
    input,
  };
}

describe("executeZendeskTool", () => {
  it("searches requester tickets with a bounded query", async () => {
    const zafRequest = vi.fn().mockResolvedValue({
      results: [
        {
          id: 7314,
          subject: "Damaged item",
          status: "solved",
          created_at: "2026-01-01T12:00:00.000Z",
          updated_at: "2026-01-02T12:00:00.000Z",
          description: "Replacement sent",
        },
      ],
    });
    const client = { request: zafRequest } as unknown as ZafClient;

    const result = await executeZendeskTool(
      client,
      request("zendesk_get_requester_tickets", {
        requesterId: 77,
        limit: 10,
      }),
      "example",
    );

    const options = zafRequest.mock.calls[0]?.[0];
    const query = new URL(
      options.url,
      "https://example.zendesk.com",
    ).searchParams.get("query");
    expect(query).toContain("type:ticket");
    expect(query).toContain("requester:77");
    expect(options).toMatchObject({ type: "GET", autoRetry: true });
    expect(result).toMatchObject({
      toolUseId: "tool_1",
      isError: false,
      output: {
        tickets: [{ ticketId: 7314, snippet: "Replacement sent" }],
        citations: [
          {
            provider: "zendesk",
            providerId: "7314",
            url: "https://example.zendesk.com/agent/tickets/7314",
          },
        ],
      },
    });
  });

  it("forces solved status into pattern searches", async () => {
    const zafRequest = vi.fn().mockResolvedValue({ results: [] });
    const client = { request: zafRequest } as unknown as ZafClient;

    await executeZendeskTool(
      client,
      request("zendesk_search_solved_tickets", {
        terms: ["damaged item"],
        limit: 10,
      }),
      "example",
    );

    const query = new URL(
      zafRequest.mock.calls[0]?.[0].url,
      "https://example.zendesk.com",
    ).searchParams.get("query");
    expect(query).toContain("status:solved");
    expect(query).toContain('"damaged item"');
  });

  it("gets one ticket and compacts comments", async () => {
    const zafRequest = vi
      .fn()
      .mockResolvedValueOnce({
        ticket: {
          id: 7314,
          subject: "Damaged item",
          status: "solved",
          created_at: "2026-01-01T12:00:00.000Z",
          updated_at: "2026-01-02T12:00:00.000Z",
          description: "Replacement sent",
        },
      })
      .mockResolvedValueOnce({
        comments: [
          {
            author_id: 22,
            plain_body: "We sent a replacement.",
            created_at: "2026-01-02T12:00:00.000Z",
            public: true,
            via: { source: { from: { name: "Support Agent" } } },
          },
        ],
      });
    const client = { request: zafRequest } as unknown as ZafClient;

    const result = await executeZendeskTool(
      client,
      request("zendesk_get_ticket", { ticketId: 7314 }),
      "example",
    );

    expect(zafRequest).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      output: {
        ticket: {
          ticketId: 7314,
          comments: [
            {
              authorName: "Support Agent",
              body: "We sent a replacement.",
              public: true,
            },
          ],
        },
      },
    });
  });

  it("lists only HTTPS voice comments with ticket citations", async () => {
    const zafRequest = vi.fn().mockResolvedValue({
      comments: [
        {
          id: 99,
          type: "VoiceComment",
          recording_url: "https://recordings.example/99.mp3",
          transcription_text: "",
          created_at: "2026-07-20T12:00:00Z",
        },
        {
          id: 100,
          type: "VoiceComment",
          recording_url: "http://recordings.example/100.mp3",
          transcription_text: "insecure",
          created_at: "2026-07-20T12:01:00Z",
        },
        {
          id: 101,
          type: "Comment",
          recording_url: "https://recordings.example/101.mp3",
          transcription_text: "not a voicemail",
          created_at: "2026-07-20T12:02:00Z",
        },
        {
          id: 102,
          type: "VoiceComment",
          recording_url: "not a URL",
          transcription_text: "invalid",
          created_at: "2026-07-20T12:03:00Z",
        },
        {
          id: 103,
          type: "VoiceComment",
          recording_url: "https://recordings.example/103.mp3",
          transcription_text: "invalid date",
          created_at: "not a date",
        },
      ],
    });
    const client = { request: zafRequest } as unknown as ZafClient;

    const result = await executeZendeskTool(
      client,
      request("zendesk_list_voicemails", { ticketId: 7314 }),
      "example",
    );

    expect(zafRequest).toHaveBeenCalledWith({
      url: "/api/v2/tickets/7314/comments.json?sort_order=desc",
      type: "GET",
      autoRetry: true,
    });
    expect(result).toMatchObject({
      toolUseId: "tool_1",
      toolName: "zendesk_list_voicemails",
      isError: false,
      output: {
        voicemails: [
          {
            ticketId: 7314,
            commentId: 99,
            recordingUrl: "https://recordings.example/99.mp3",
            transcriptionText: "",
            createdAt: "2026-07-20T12:00:00.000Z",
          },
        ],
        citations: [
          {
            provider: "zendesk",
            label: "Ticket 7314",
            providerId: "7314",
            url: "https://example.zendesk.com/agent/tickets/7314",
          },
        ],
      },
    });
  });

  it("bounds voicemail listings to 30 comments", async () => {
    const zafRequest = vi.fn().mockResolvedValue({
      comments: Array.from({ length: 31 }, (_, index) => ({
        id: index + 1,
        type: "VoiceComment",
        recording_url: `https://recordings.example/${index + 1}.mp3`,
        transcription_text: "",
        created_at: "2026-07-20T12:00:00Z",
      })),
    });
    const client = { request: zafRequest } as unknown as ZafClient;

    const result = await executeZendeskTool(
      client,
      request("zendesk_list_voicemails", { ticketId: 7314 }),
      "example",
    );

    expect(result).toMatchObject({
      output: {
        voicemails: expect.any(Array),
      },
    });
    expect(
      (result.output as { voicemails: unknown[] }).voicemails,
    ).toHaveLength(30);
  });

  it("reads ticket-field definitions with active state and options", async () => {
    const zafRequest = vi.fn().mockResolvedValue({
      ticket_fields: [
        {
          id: 123,
          title: "Resolution",
          type: "tagger",
          active: true,
          custom_field_options: [{ name: "Approved", value: "approved" }],
        },
        {
          id: 124,
          title: "Reference",
          type: "regexp",
          active: true,
          regexp_for_validation: "^[A-Z]{3}-\\d+$",
          custom_field_options: [],
        },
      ],
    });
    const client = { request: zafRequest } as unknown as ZafClient;

    const result = await executeZendeskTool(
      client,
      request("zendesk_list_ticket_field_definitions", {}),
      "example",
    );

    expect(zafRequest).toHaveBeenCalledWith({
      url: "/api/v2/ticket_fields.json",
      type: "GET",
      autoRetry: true,
    });
    expect(result.output).toEqual({
      fields: [
        {
          id: 123,
          title: "Resolution",
          type: "tagger",
          active: true,
          options: [{ name: "Approved", value: "approved" }],
        },
        {
          id: 124,
          title: "Reference",
          type: "regexp",
          active: true,
          regexpForValidation: "^[A-Z]{3}-\\d+$",
          options: [],
        },
      ],
    });
  });

  it("rejects inactive and invalid ticket options before rendering a proposal", async () => {
    const proposal: WriteProposal = {
      id: "turn_1",
      action: "zendesk_update_ticket_custom_fields",
      targetId: 8421,
      before: { "123": "pending" },
      changes: { "123": "approved" },
      expiresAt: "2099-07-21T12:10:00.000Z",
    };
    const ticket = {
      ticket: {
        id: 8421,
        updated_at: "2026-07-21T12:00:00.000Z",
        custom_fields: [{ id: 123, value: "pending" }],
      },
    };
    const definitions = (active: boolean, value: string) => ({
      ticket_fields: [
        {
          id: 123,
          title: "Resolution",
          type: "tagger",
          active,
          custom_field_options: [{ name: "Other", value }],
        },
      ],
    });

    for (const fieldDefinitions of [
      definitions(false, "approved"),
      definitions(true, "other"),
    ]) {
      const client = {
        request: vi
          .fn()
          .mockResolvedValueOnce(ticket)
          .mockResolvedValueOnce(fieldDefinitions),
      } as unknown as ZafClient;
      await expect(inspectZendeskProposal(client, proposal)).rejects.toThrow();
    }
  });

  it("accepts only configured values in multi-select ticket fields", async () => {
    const client = {
      request: vi
        .fn()
        .mockResolvedValueOnce({
          ticket: {
            id: 8421,
            updated_at: "version-1",
            custom_fields: [{ id: 123, value: ["pending"] }],
          },
        })
        .mockResolvedValueOnce({
          ticket_fields: [
            {
              id: 123,
              title: "Resolution tags",
              type: "multiselect",
              active: true,
              custom_field_options: [
                { name: "Pending", value: "pending" },
                { name: "Approved", value: "approved" },
              ],
            },
          ],
        }),
    } as unknown as ZafClient;

    await expect(
      inspectZendeskProposal(client, {
        id: "turn_1",
        action: "zendesk_update_ticket_custom_fields",
        targetId: 8421,
        before: { "123": ["pending"] },
        changes: { "123": ["pending", "approved"] },
        expiresAt: "2099-07-21T12:10:00.000Z",
      }),
    ).resolves.toEqual({ recordVersion: "version-1" });
  });

  it.each([
    {
      label: "scalar multiselect",
      type: "multiselect",
      before: ["pending"],
      after: "approved",
      options: [
        { name: "Pending", value: "pending" },
        { name: "Approved", value: "approved" },
      ],
    },
    {
      label: "string checkbox",
      type: "checkbox",
      before: false,
      after: "true",
      options: [],
    },
    {
      label: "malformed date",
      type: "date",
      before: "2026-07-20",
      after: "07/21/2026",
      options: [],
    },
    {
      label: "decimal integer",
      type: "integer",
      before: "12",
      after: "12.5",
      options: [],
    },
    {
      label: "non-numeric decimal",
      type: "decimal",
      before: "12.5",
      after: "12mg",
      options: [],
    },
  ])(
    "rejects $label values before preview",
    async ({ type, before, after, options }) => {
      const client = {
        request: vi
          .fn()
          .mockResolvedValueOnce({
            ticket: {
              id: 8421,
              updated_at: "version-1",
              custom_fields: [{ id: 123, value: before }],
            },
          })
          .mockResolvedValueOnce({
            ticket_fields: [
              {
                id: 123,
                title: "Typed field",
                type,
                active: true,
                custom_field_options: options,
              },
            ],
          }),
      } as unknown as ZafClient;

      await expect(
        inspectZendeskProposal(client, {
          id: "turn_1",
          action: "zendesk_update_ticket_custom_fields",
          targetId: 8421,
          before: { "123": before },
          changes: { "123": after },
          expiresAt: "2099-07-21T12:10:00.000Z",
        }),
      ).rejects.toThrow("invalid");
    },
  );

  it("revalidates field shape immediately before PUT", async () => {
    const zafRequest = vi
      .fn()
      .mockResolvedValueOnce({
        ticket: {
          id: 8421,
          updated_at: "version-1",
          custom_fields: [{ id: 123, value: false }],
        },
      })
      .mockResolvedValueOnce({
        ticket_fields: [
          {
            id: 123,
            title: "Approved",
            type: "checkbox",
            active: true,
            custom_field_options: [],
          },
        ],
      });

    await expect(
      executeConfirmedZendeskAction(
        { request: zafRequest } as unknown as ZafClient,
        request("zendesk_update_ticket_custom_fields", {
          ticketId: 8421,
          recordVersion: "version-1",
          before: { "123": false },
          changes: { "123": "true" },
        }),
        "example",
      ),
    ).rejects.toThrow("invalid");
    expect(
      zafRequest.mock.calls.some(([options]) => options.type === "PUT"),
    ).toBe(false);
  });

  it.each([
    {
      type: "lookup",
      before: { id: 1, name: "Account" },
      after: { id: 2, name: "Other account" },
    },
    {
      type: "partialcreditcard",
      before: "4242",
      after: "1111",
    },
  ])(
    "rejects unsupported $type fields before preview",
    async ({ type, before, after }) => {
      const client = {
        request: vi
          .fn()
          .mockResolvedValueOnce({
            ticket: {
              id: 8421,
              updated_at: "version-1",
              custom_fields: [{ id: 123, value: before }],
            },
          })
          .mockResolvedValueOnce({
            ticket_fields: [
              {
                id: 123,
                title: "Unsupported field",
                type,
                active: true,
                custom_field_options: [],
              },
            ],
          }),
      } as unknown as ZafClient;

      await expect(
        inspectZendeskProposal(client, {
          id: "turn_1",
          action: "zendesk_update_ticket_custom_fields",
          targetId: 8421,
          before: { "123": before },
          changes: { "123": after },
          expiresAt: "2099-07-21T12:10:00.000Z",
        }),
      ).rejects.toThrow("invalid");
    },
  );

  it.each([
    {
      type: "lookup",
      before: { id: 1, name: "Account" },
      after: { id: 2, name: "Other account" },
    },
    {
      type: "partialcreditcard",
      before: "4242",
      after: "1111",
    },
  ])(
    "rejects unsupported $type fields immediately before PUT",
    async ({ type, before, after }) => {
      const zafRequest = vi
        .fn()
        .mockResolvedValueOnce({
          ticket: {
            id: 8421,
            updated_at: "version-1",
            custom_fields: [{ id: 123, value: before }],
          },
        })
        .mockResolvedValueOnce({
          ticket_fields: [
            {
              id: 123,
              title: "Unsupported field",
              type,
              active: true,
              custom_field_options: [],
            },
          ],
        });

      await expect(
        executeConfirmedZendeskAction(
          { request: zafRequest } as unknown as ZafClient,
          request("zendesk_update_ticket_custom_fields", {
            ticketId: 8421,
            recordVersion: "version-1",
            before: { "123": before },
            changes: { "123": after },
          }),
          "example",
        ),
      ).rejects.toThrow("invalid");
      expect(
        zafRequest.mock.calls.some(([options]) => options.type === "PUT"),
      ).toBe(false);
    },
  );

  it("accepts regexp fields that match their validation metadata", async () => {
    const client = {
      request: vi
        .fn()
        .mockResolvedValueOnce({
          ticket: {
            id: 8421,
            updated_at: "version-1",
            custom_fields: [{ id: 123, value: "ABC-1" }],
          },
        })
        .mockResolvedValueOnce({
          ticket_fields: [
            {
              id: 123,
              title: "Reference",
              type: "regexp",
              active: true,
              regexp_for_validation: "^[A-Z]{3}-\\d+$",
              custom_field_options: [],
            },
          ],
        }),
    } as unknown as ZafClient;

    await expect(
      inspectZendeskProposal(client, {
        id: "turn_1",
        action: "zendesk_update_ticket_custom_fields",
        targetId: 8421,
        before: { "123": "ABC-1" },
        changes: { "123": "XYZ-2" },
        expiresAt: "2099-07-21T12:10:00.000Z",
      }),
    ).resolves.toEqual({ recordVersion: "version-1" });
  });

  it.each([
    {
      label: "nonmatching",
      pattern: "^[A-Z]{3}-\\d+$",
      after: "not-a-reference",
    },
    { label: "missing-metadata", pattern: undefined, after: "XYZ-2" },
    { label: "invalid-metadata", pattern: "[", after: "XYZ-2" },
  ])("rejects $label regexp fields safely", async ({ pattern, after }) => {
    const definition = {
      id: 123,
      title: "Reference",
      type: "regexp",
      active: true,
      custom_field_options: [],
      ...(pattern === undefined ? {} : { regexp_for_validation: pattern }),
    };
    const client = {
      request: vi
        .fn()
        .mockResolvedValueOnce({
          ticket: {
            id: 8421,
            updated_at: "version-1",
            custom_fields: [{ id: 123, value: "ABC-1" }],
          },
        })
        .mockResolvedValueOnce({ ticket_fields: [definition] }),
    } as unknown as ZafClient;

    await expect(
      inspectZendeskProposal(client, {
        id: "turn_1",
        action: "zendesk_update_ticket_custom_fields",
        targetId: 8421,
        before: { "123": "ABC-1" },
        changes: { "123": after },
        expiresAt: "2099-07-21T12:10:00.000Z",
      }),
    ).rejects.toThrow("invalid");
  });

  it("rejects unconfigured customer user fields before rendering", async () => {
    const proposal: WriteProposal = {
      id: "turn_1",
      action: "zendesk_update_customer_profile",
      targetId: 77,
      before: { user_fields: { customer_tier: "silver" } },
      changes: { user_fields: { unconfigured_field: "gold" } },
      expiresAt: "2099-07-21T12:10:00.000Z",
    };
    const client = {
      request: vi.fn().mockResolvedValue({
        user: {
          id: 77,
          updated_at: "2026-07-21T12:00:00.000Z",
          name: "Maya Chen",
          phone: "+15551230000",
          notes: "",
          organization_id: 42,
          user_fields: { customer_tier: "silver" },
        },
      }),
    } as unknown as ZafClient;

    await expect(inspectZendeskProposal(client, proposal)).rejects.toThrow(
      "not configured",
    );
  });

  it("refuses a stale confirmed write before sending PUT", async () => {
    const zafRequest = vi.fn().mockResolvedValue({
      user: {
        id: 77,
        updated_at: "version-2",
        name: "Maya Chen",
        phone: "+15551230000",
        notes: "",
        organization_id: 42,
        user_fields: {},
      },
    });
    const client = { request: zafRequest } as unknown as ZafClient;

    await expect(
      executeConfirmedZendeskAction(
        client,
        request("zendesk_update_customer_profile", {
          userId: 77,
          recordVersion: "version-1",
          before: { phone: "+15551230000" },
          changes: { phone: "+15559870000" },
        }),
        "example",
      ),
    ).rejects.toThrow("changed");
    expect(
      zafRequest.mock.calls.some(([options]) => options.type === "PUT"),
    ).toBe(false);
  });

  it("writes through ZAF once, refetches, and returns verified profile state", async () => {
    const before = {
      user: {
        id: 77,
        updated_at: "version-1",
        name: "Maya Chen",
        phone: "+15551230000",
        notes: "",
        organization_id: 42,
        user_fields: { customer_tier: "silver" },
      },
    };
    const after = {
      user: {
        ...before.user,
        updated_at: "version-2",
        phone: "+15559870000",
        user_fields: { customer_tier: "gold" },
      },
    };
    const zafRequest = vi
      .fn()
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce({ user: after.user })
      .mockResolvedValueOnce(after);
    const client = { request: zafRequest } as unknown as ZafClient;

    const result = await executeConfirmedZendeskAction(
      client,
      request("zendesk_update_customer_profile", {
        userId: 77,
        recordVersion: "version-1",
        before: {
          phone: "+15551230000",
          user_fields: { customer_tier: "silver" },
        },
        changes: {
          phone: "+15559870000",
          user_fields: { customer_tier: "gold" },
        },
      }),
      "example",
    );

    expect(zafRequest).toHaveBeenNthCalledWith(2, {
      url: "/api/v2/users/77.json",
      type: "PUT",
      autoRetry: false,
      contentType: "application/json",
      data: JSON.stringify({
        user: {
          phone: "+15559870000",
          user_fields: { customer_tier: "gold" },
        },
      }),
    });
    expect(result).toMatchObject({
      output: {
        targetId: 77,
        recordVersion: "version-2",
        before: {
          phone: "+15551230000",
          user_fields: { customer_tier: "silver" },
        },
        after: {
          phone: "+15559870000",
          user_fields: { customer_tier: "gold" },
        },
        verified: true,
      },
    });
  });

  it("writes validated ticket custom fields and verifies the refetch", async () => {
    const before = {
      ticket: {
        id: 8421,
        updated_at: "version-1",
        custom_fields: [{ id: 123, value: "pending" }],
      },
    };
    const definitions = {
      ticket_fields: [
        {
          id: 123,
          title: "Resolution",
          type: "tagger",
          active: true,
          custom_field_options: [
            { name: "Pending", value: "pending" },
            { name: "Approved", value: "approved" },
          ],
        },
      ],
    };
    const after = {
      ticket: {
        ...before.ticket,
        updated_at: "version-2",
        custom_fields: [{ id: 123, value: "approved" }],
      },
    };
    const zafRequest = vi
      .fn()
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(definitions)
      .mockResolvedValueOnce(after)
      .mockResolvedValueOnce(after);
    const client = { request: zafRequest } as unknown as ZafClient;

    const result = await executeConfirmedZendeskAction(
      client,
      request("zendesk_update_ticket_custom_fields", {
        ticketId: 8421,
        recordVersion: "version-1",
        before: { "123": "pending" },
        changes: { "123": "approved" },
      }),
      "example",
    );

    expect(zafRequest).toHaveBeenNthCalledWith(3, {
      url: "/api/v2/tickets/8421.json",
      type: "PUT",
      autoRetry: false,
      contentType: "application/json",
      data: JSON.stringify({
        ticket: { custom_fields: [{ id: 123, value: "approved" }] },
      }),
    });
    expect(result).toMatchObject({
      output: {
        targetId: 8421,
        recordVersion: "version-2",
        before: { "123": "pending" },
        after: { "123": "approved" },
        verified: true,
      },
    });
  });

  it("never executes a write through the unconfirmed delegated executor", async () => {
    const zafRequest = vi.fn();
    const client = { request: zafRequest } as unknown as ZafClient;

    await expect(
      executeZendeskTool(
        client,
        request("zendesk_update_customer_profile", {
          userId: 77,
          recordVersion: "version-1",
          before: { phone: "+15551230000" },
          changes: { phone: "+15559870000" },
        }),
        "example",
      ),
    ).rejects.toThrow("Unsupported delegated tool");
    expect(zafRequest).not.toHaveBeenCalled();
  });

  it("refuses unregistered delegated tools", async () => {
    const client = { request: vi.fn() } as unknown as ZafClient;

    await expect(
      executeZendeskTool(
        client,
        request("zendesk_delete_ticket", { ticketId: 7314 }),
        "example",
      ),
    ).rejects.toThrow("Unsupported delegated tool");
  });
});
