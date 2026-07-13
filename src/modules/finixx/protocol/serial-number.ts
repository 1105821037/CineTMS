const TICKS_AT_UNIX_EPOCH = 621355968000000000n;
const TICKS_PER_MILLISECOND = 10_000n;

export function createFinixxSerialNumber(now: Date = new Date()): string {
  const unixMilliseconds = BigInt(now.getTime());
  return (TICKS_AT_UNIX_EPOCH + unixMilliseconds * TICKS_PER_MILLISECOND).toString();
}
