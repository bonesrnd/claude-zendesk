import {
  NormalizedPhoneSchema,
  type NormalizedPhone,
} from "@resolve/contracts";

const EXTENSION_SUFFIX = /\s*(?:(?:ext(?:ension)?\.?|x|#)\s*\d+)\s*$/i;

export function normalizePhone(
  value: string,
  countryCode?: string,
): NormalizedPhone {
  const digits = value.replace(EXTENSION_SUFFIX, "").replace(/\D/g, "");
  const countryDigits = countryCode?.replace(/\D/g, "") ?? "";

  if (digits.length < 7) {
    throw new Error("Phone number must contain at least seven digits");
  }

  const hasCountryCode =
    countryDigits.length > 0 && digits.startsWith(countryDigits);
  const canonicalDigits =
    countryDigits.length > 0 && !hasCountryCode
      ? `${countryDigits}${digits}`
      : digits;
  const nationalDigits =
    countryDigits.length > 0 && canonicalDigits.startsWith(countryDigits)
      ? canonicalDigits.slice(countryDigits.length)
      : canonicalDigits.length === 11 && canonicalDigits.startsWith("1")
        ? canonicalDigits.slice(1)
        : canonicalDigits;

  return NormalizedPhoneSchema.parse({
    digits: canonicalDigits,
    nationalDigits,
  });
}

export function phonesMatch(
  left: string,
  right: string,
  countryCode?: string,
): boolean {
  try {
    return normalizedPhonesMatch(
      normalizePhone(left, countryCode),
      normalizePhone(right, countryCode),
    );
  } catch {
    return false;
  }
}

export function normalizedPhonesMatch(
  left: NormalizedPhone,
  right: NormalizedPhone,
): boolean {
  if (
    left.digits === right.digits ||
    left.nationalDigits === right.nationalDigits
  ) {
    return true;
  }

  return (
    left.digits.length >= 10 &&
    right.digits.length >= 10 &&
    left.digits.slice(-10) === right.digits.slice(-10)
  );
}
