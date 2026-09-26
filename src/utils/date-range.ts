/**
 * Date-range presets for order/delivery filters.
 *
 * Returns YYYY-MM-DD strings (local day boundaries) that both the backend
 * (normalizes to UTC day bounds) and the local SQLite read-model
 * (`inserted_at >= from` / `inserted_at < `${to}T23:59:59``) accept.
 */

export type DatePreset = "all" | "today" | "yesterday" | "last7" | "custom";

export interface DateRange {
  date_from?: string;
  date_to?: string;
}

function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDays(base: Date, days: number): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d;
}

export function resolveDateRange(
  preset: DatePreset | string | undefined,
  customFrom?: string,
  customTo?: string,
): DateRange {
  const today = new Date();
  switch (preset) {
    case "today":
      return { date_from: toISODate(today), date_to: toISODate(today) };
    case "yesterday": {
      const y = toISODate(addDays(today, -1));
      return { date_from: y, date_to: y };
    }
    case "last7":
      return { date_from: toISODate(addDays(today, -6)), date_to: toISODate(today) };
    case "custom":
      return {
        ...(customFrom ? { date_from: customFrom } : {}),
        ...(customTo ? { date_to: customTo } : {}),
      };
    default:
      return {};
  }
}

export const DATE_PRESET_LABELS: Array<{ key: DatePreset; label: string }> = [
  { key: "all", label: "All time" },
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "last7", label: "Last 7 days" },
  { key: "custom", label: "Custom" },
];
