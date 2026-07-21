import {
  PhoneSearchResultSchema,
  type PhoneSearchResult,
} from "@resolve/contracts";
import { normalizePhone } from "@resolve/skills";
import { z } from "zod";

interface PhoneCacheRow {
  result_json: string;
  incomplete: number;
  expires_at: string;
}

interface PhoneLookupInput {
  phone: string;
  countryCode?: string;
}

const CACHE_ENVELOPE_VERSION = 1;
const AES_GCM_NONCE_BYTES = 12;
const KEY_DERIVATION_SALT = new TextEncoder().encode(
  "resolve-phone-cache-key-derivation-v1",
);
const ENCRYPTION_KEY_INFO = new TextEncoder().encode(
  "resolve-phone-cache-aes-gcm-v1",
);
const EncryptedCacheEnvelopeSchema = z.strictObject({
  version: z.literal(CACHE_ENVELOPE_VERSION),
  nonce: z.string().regex(/^[A-Za-z0-9_-]+$/u),
  ciphertext: z.string().regex(/^[A-Za-z0-9_-]+$/u),
});

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export class PhoneCacheRepository {
  private signingKey: Promise<CryptoKey> | undefined;
  private encryptionKey: Promise<CryptoKey> | undefined;

  constructor(
    private readonly db: D1Database,
    private readonly hmacKey: string,
    private readonly now: () => Date = () => new Date(),
    private readonly ttlMilliseconds = 15 * 60 * 1_000,
  ) {
    if (!hmacKey) throw new Error("Phone cache HMAC key is required");
  }

  private async hash(input: PhoneLookupInput): Promise<string> {
    const normalized = normalizePhone(input.phone, input.countryCode);
    this.signingKey ??= crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(this.hmacKey),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = await crypto.subtle.sign(
      "HMAC",
      await this.signingKey,
      new TextEncoder().encode(normalized.digits),
    );
    return [...new Uint8Array(signature)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }

  private payloadKey(): Promise<CryptoKey> {
    this.encryptionKey ??= crypto.subtle
      .importKey("raw", new TextEncoder().encode(this.hmacKey), "HKDF", false, [
        "deriveKey",
      ])
      .then((keyMaterial) =>
        crypto.subtle.deriveKey(
          {
            name: "HKDF",
            hash: "SHA-256",
            salt: KEY_DERIVATION_SALT,
            info: ENCRYPTION_KEY_INFO,
          },
          keyMaterial,
          { name: "AES-GCM", length: 256 },
          false,
          ["encrypt", "decrypt"],
        ),
      );
    return this.encryptionKey;
  }

  private additionalData(phoneHash: string, incomplete: number): Uint8Array {
    return new TextEncoder().encode(
      `resolve-phone-cache:v${CACHE_ENVELOPE_VERSION}:${phoneHash}:${incomplete}`,
    );
  }

  private async encrypt(
    phoneHash: string,
    result: PhoneSearchResult,
  ): Promise<string> {
    const nonce = crypto.getRandomValues(new Uint8Array(AES_GCM_NONCE_BYTES));
    const incomplete = result.incomplete ? 1 : 0;
    const ciphertext = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: nonce,
        additionalData: this.additionalData(phoneHash, incomplete),
      },
      await this.payloadKey(),
      new TextEncoder().encode(JSON.stringify(result)),
    );
    return JSON.stringify({
      version: CACHE_ENVELOPE_VERSION,
      nonce: base64UrlEncode(nonce),
      ciphertext: base64UrlEncode(new Uint8Array(ciphertext)),
    });
  }

  private async decrypt(
    phoneHash: string,
    row: PhoneCacheRow,
  ): Promise<PhoneSearchResult> {
    const envelope = EncryptedCacheEnvelopeSchema.parse(
      JSON.parse(row.result_json),
    );
    const nonce = base64UrlDecode(envelope.nonce);
    const ciphertext = base64UrlDecode(envelope.ciphertext);
    if (
      nonce.byteLength !== AES_GCM_NONCE_BYTES ||
      ciphertext.byteLength < 16
    ) {
      throw new Error("Phone cache encryption envelope is invalid");
    }
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: nonce,
        additionalData: this.additionalData(phoneHash, row.incomplete),
      },
      await this.payloadKey(),
      ciphertext,
    );
    return PhoneSearchResultSchema.parse(
      JSON.parse(
        new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: false,
        }).decode(plaintext),
      ),
    );
  }

  private delete(phoneHash: string): Promise<D1Result<unknown>> {
    return this.db
      .prepare("DELETE FROM shipstation_phone_cache WHERE phone_hash = ?")
      .bind(phoneHash)
      .run();
  }

  async get(input: PhoneLookupInput): Promise<PhoneSearchResult | undefined> {
    const phoneHash = await this.hash(input);
    const row = await this.db
      .prepare(
        `SELECT result_json, incomplete, expires_at
         FROM shipstation_phone_cache
         WHERE phone_hash = ?`,
      )
      .bind(phoneHash)
      .first<PhoneCacheRow>();
    if (!row) return undefined;
    if (row.expires_at <= this.now().toISOString()) {
      await this.delete(phoneHash);
      return undefined;
    }
    try {
      const result = await this.decrypt(phoneHash, row);
      if (result.incomplete !== (row.incomplete === 1)) {
        throw new Error("Phone cache completeness metadata is invalid");
      }
      return result;
    } catch {
      await this.delete(phoneHash);
      return undefined;
    }
  }

  async set(input: PhoneLookupInput, result: PhoneSearchResult): Promise<void> {
    const phoneHash = await this.hash(input);
    const safeResult = PhoneSearchResultSchema.parse(result);
    const encryptedResult = await this.encrypt(phoneHash, safeResult);
    const expiresAt = new Date(
      this.now().getTime() + this.ttlMilliseconds,
    ).toISOString();
    await this.db
      .prepare(
        `INSERT INTO shipstation_phone_cache
          (phone_hash, result_json, incomplete, expires_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(phone_hash) DO UPDATE SET
           result_json = excluded.result_json,
           incomplete = excluded.incomplete,
           expires_at = excluded.expires_at`,
      )
      .bind(
        phoneHash,
        encryptedResult,
        safeResult.incomplete ? 1 : 0,
        expiresAt,
      )
      .run();
  }
}
