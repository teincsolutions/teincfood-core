/**
 * Company footer info for receipts — platform/brand block printed under
 * the receipt footer ("Powered by" section).
 *
 * Defaults match docs/receipt-template.md §4. Host apps override at boot
 * from env (desktop: VITE_COMPANY_*, mobile: EXPO_PUBLIC_COMPANY_*) via
 * setCompanyInfo; unset fields fall back to defaults. The backend reads
 * COMPANY_* OS env with the same defaults.
 */

export interface CompanyInfo {
  /** Company name, e.g. "TeincFood". */
  name: string;
  /** Consumer brand line, e.g. "TeincFood Business". */
  brand: string;
  address: string;
  website: string;
  supportEmail: string;
  phone: string;
}

const DEFAULTS: CompanyInfo = {
  name: "TeincFood",
  brand: "TeincFood Business",
  address: "Accra, Ghana",
  website: "https://teincfood.com",
  supportEmail: "support@teincfood.com",
  phone: "+233 50 398 1913",
};

let override: Partial<CompanyInfo> = {};

export function setCompanyInfo(partial: Partial<CompanyInfo>): void {
  const clean: Partial<CompanyInfo> = {};
  for (const [k, v] of Object.entries(partial)) {
    if (typeof v === "string" && v.length > 0) {
      (clean as Record<string, string>)[k] = v;
    }
  }
  override = { ...override, ...clean };
}

export function getCompanyInfo(): CompanyInfo {
  return { ...DEFAULTS, ...override };
}
