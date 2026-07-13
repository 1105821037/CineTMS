import type { FinixxResultMessageMap } from "../sdk/types";

export function resolveFinixxResultMessage(
  result: number | null | undefined,
  resultMessageMap?: FinixxResultMessageMap,
): string | undefined {
  if (result === undefined || result === null || !resultMessageMap) {
    return undefined;
  }

  return resultMessageMap[String(result)];
}
