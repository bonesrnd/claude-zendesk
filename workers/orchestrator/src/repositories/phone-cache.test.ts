import type { PhoneSearchResult } from "@resolve/contracts";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { PhoneCacheRepository } from "./phone-cache";

const START = new Date("2026-07-20T16:00:00.000Z");
const result: PhoneSearchResult = {
  customers: [
    {
      provider: "shipstation",
      providerId: "77331",
      name: "Maya Chen",
      email: "maya@example.com",
      phone: "(512) 555-0199",
      sourceUrl: "https://ship.shipstation.com/customers?quickSearch=77331",
    },
  ],
  orders: [
    {
      provider: "shipstation",
      providerId: "445566",
      orderNumber: "10982",
      status: "awaiting_shipment",
      billingSummary: {
        name: "Maya Chen",
        company: "Private Clinic",
        city: "Austin",
        state: "Texas",
        postalCode: "78701",
        email: "maya@example.com",
        phone: "+1 512-555-0199",
      },
      shippingSummary: {
        name: "Maya Chen",
        company: "Home Address",
        city: "Round Rock",
        state: "Texas",
        postalCode: "78664",
        email: "maya@example.com",
        phone: "+1 512-555-0199",
      },
      refunds: [],
      sourceUrl: "https://ship.shipstation.com/orders?quickSearch=10982",
      lineItems: [],
      metadata: [],
    },
  ],
  citations: [
    {
      provider: "shipstation",
      providerId: "77331",
      label: "ShipStation customer Maya Chen",
      url: "https://ship.shipstation.com/customers?quickSearch=77331",
    },
  ],
  searchedRecords: 34,
  incomplete: true,
  apiVersion: "v1",
};

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM shipstation_phone_cache").run();
});

describe("PhoneCacheRepository", () => {
  it("stores only a versioned encrypted envelope and round-trips the complete result", async () => {
    const repository = new PhoneCacheRepository(
      env.DB,
      "test-phone-hmac-key",
      () => START,
      60_000,
    );

    await repository.set({ phone: "+1 (512) 555-0199 ext 4" }, result);

    const row = await env.DB.prepare(
      "SELECT phone_hash, result_json, incomplete FROM shipstation_phone_cache",
    ).first<{
      phone_hash: string;
      result_json: string;
      incomplete: number;
    }>();
    expect(row?.phone_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(row?.phone_hash).not.toContain("15125550199");
    const envelope = JSON.parse(row?.result_json ?? "{}");
    expect(envelope).toEqual({
      version: 1,
      nonce: expect.stringMatching(/^[A-Za-z0-9_-]+$/),
      ciphertext: expect.stringMatching(/^[A-Za-z0-9_-]+$/),
    });
    for (const plaintext of [
      "Maya Chen",
      "maya@example.com",
      "Private Clinic",
      "Home Address",
      "Austin",
      "Round Rock",
      "Texas",
      "78701",
      "78664",
      "5125550199",
      "(512) 555-0199",
      "+1 512-555-0199",
      "shipstation",
      "77331",
      "445566",
      "10982",
      "awaiting_shipment",
    ]) {
      expect(row?.result_json).not.toContain(plaintext);
    }
    expect(row?.incomplete).toBe(1);

    const cached = await repository.get({
      phone: "(512) 555-0199",
      countryCode: "+1",
    });
    expect(cached).toEqual(result);
  });

  it("fails closed for tampered ciphertext and a wrong encryption key", async () => {
    const input = { phone: "5125550199", countryCode: "1" };
    const repository = new PhoneCacheRepository(
      env.DB,
      "correct-phone-cache-key",
      () => START,
      60_000,
    );
    await repository.set(input, result);
    const original = await env.DB.prepare(
      "SELECT phone_hash, result_json, incomplete FROM shipstation_phone_cache",
    ).first<{
      phone_hash: string;
      result_json: string;
      incomplete: number;
    }>();
    if (!original) throw new Error("Expected encrypted phone cache row");

    const tampered = JSON.parse(original.result_json) as {
      version: number;
      nonce: string;
      ciphertext: string;
    };
    const tamperIndex = Math.floor(tampered.ciphertext.length / 2);
    const replacement = tampered.ciphertext[tamperIndex] === "A" ? "B" : "A";
    tampered.ciphertext = `${tampered.ciphertext.slice(
      0,
      tamperIndex,
    )}${replacement}${tampered.ciphertext.slice(tamperIndex + 1)}`;
    await env.DB.prepare(
      "UPDATE shipstation_phone_cache SET result_json = ? WHERE phone_hash = ?",
    )
      .bind(JSON.stringify(tampered), original.phone_hash)
      .run();

    await expect(repository.get(input)).resolves.toBeUndefined();

    await repository.set(input, result);
    const restored = await env.DB.prepare(
      "SELECT phone_hash, result_json, incomplete FROM shipstation_phone_cache",
    ).first<{
      phone_hash: string;
      result_json: string;
      incomplete: number;
    }>();
    if (!restored) throw new Error("Expected restored phone cache row");
    const wrongKeyRepository = new PhoneCacheRepository(
      env.DB,
      "rotated-phone-cache-key",
      () => START,
      60_000,
    );
    await wrongKeyRepository.set(input, result);
    const rows = await env.DB.prepare(
      "SELECT phone_hash FROM shipstation_phone_cache",
    ).all<{ phone_hash: string }>();
    const wrongKeyHash = rows.results.find(
      ({ phone_hash }) => phone_hash !== restored.phone_hash,
    )?.phone_hash;
    if (!wrongKeyHash) throw new Error("Expected rotated phone cache key");
    await env.DB.prepare(
      `UPDATE shipstation_phone_cache
          SET result_json = ?, incomplete = ?
        WHERE phone_hash = ?`,
    )
      .bind(restored.result_json, restored.incomplete, wrongKeyHash)
      .run();

    await expect(wrongKeyRepository.get(input)).resolves.toBeUndefined();
  });

  it("does not return expired entries", async () => {
    let now = START;
    const repository = new PhoneCacheRepository(
      env.DB,
      "test-phone-hmac-key",
      () => now,
      60_000,
    );
    await repository.set({ phone: "5125550199", countryCode: "1" }, result);

    now = new Date(START.getTime() + 60_001);

    await expect(
      repository.get({ phone: "5125550199", countryCode: "1" }),
    ).resolves.toBeUndefined();
    await expect(
      env.DB.prepare(
        "SELECT COUNT(*) AS count FROM shipstation_phone_cache",
      ).first<{ count: number }>(),
    ).resolves.toEqual({ count: 0 });
  });
});
