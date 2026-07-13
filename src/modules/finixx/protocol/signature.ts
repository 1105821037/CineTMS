import { createHash } from "node:crypto";
import iconv from "iconv-lite";

type FinixxPrimitive = string | number | boolean | bigint;
type FinixxValue = FinixxPrimitive | readonly FinixxPrimitive[];
type FinixxParams = Record<string, FinixxValue | null | undefined>;

function normalizeValue(value: FinixxValue): string {
  return Array.isArray(value)
    ? JSON.stringify(value)
    : String(value);
}

export function buildFinixxSignatureText(
  params: FinixxParams,
  apiKey: string,
): string {
  const normalizedEntries = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => [key.toLowerCase(), normalizeValue(value as FinixxValue)] as const)
    .sort(([left], [right]) => left.localeCompare(right));

  const joined = normalizedEntries
    .map(([key, value]) => `${key}=${value}`)
    .join("&");

  return joined.length > 0
    ? `key=${apiKey}&${joined}`
    : `key=${apiKey}`;
}

export function signFinixxParams(
  params: FinixxParams,
  apiKey: string,
): string {
  const signatureText = buildFinixxSignatureText(params, apiKey);
  return createHash("md5")
    .update(iconv.encode(signatureText, "gb2312"))
    .digest("hex")
    .toUpperCase();
}
