/** 把 30s / 10m / 1h / 1d 转成毫秒。不合法时返回 null。 */
export function parseDuration(literal) {
  const match = String(literal ?? "").trim().match(/^(\d+)(s|m|h|d)$/);
  if (!match) return null;
  const amount = Number(match[1]);
  return { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]] * amount;
}
