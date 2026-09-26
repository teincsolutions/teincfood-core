/**
 * Format the time-of-day of an ISO date string (e.g. "2:30 PM").
 */
export function formatTime(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

/**
 * Compact date (e.g. "26 Sep 2026") for list cards where the year may be
 * implied but is still useful for older orders.
 */
export function formatDateCompact(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleDateString('en-US', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

/**
 * Date + time for order/delivery cards: "26 Sep 2026, 2:30 PM".
 */
export function formatDateTime(isoString: string): string {
  return `${formatDateCompact(isoString)}, ${formatTime(isoString)}`;
}

/**
 * Format an ISO date string into a human-readable format.
 */
export function formatDate(isoString: string, style: 'short' | 'long' = 'short'): string {
  const date = new Date(isoString);

  if (style === 'long') {
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  }

  return date.toLocaleDateString('en-US', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

/**
 * Format a date as a relative time string (e.g., "20 min ago").
 */
export function formatRelativeTime(isoString: string): string {
  const now = Date.now();
  const then = new Date(isoString).getTime();
  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60_000);

  if (diffMin < 1) return 'Just now';
  if (diffMin < 60) return `${diffMin} min ago`;

  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h ago`;

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;

  return formatDate(isoString);
}
