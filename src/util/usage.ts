/** Token usage helpers — pure functions, no VS Code dependencies. */

/** Format token count with K/M suffix. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) { return (n / 1_000_000).toFixed(1) + 'M'; }
  if (n >= 1_000) { return (n / 1_000).toFixed(0) + 'K'; }
  return String(n);
}

/** Build the status-bar usage suffix, guarding against missing/zero size. */
export function computeUsageSuffix(
  usage: { used: number; size: number } | null | undefined,
): string {
  if (usage?.size && usage.size > 0) {
    return `  ${formatTokens(usage.used)}/${formatTokens(usage.size)}`;
  }
  return '';
}
