export type PhoneCountryOption = {
  iso: string;
  name: string;
  dialCode: string;
};

export const PHONE_COUNTRIES: PhoneCountryOption[] = [
  { iso: 'GH', name: 'Ghana', dialCode: '+233' },
  { iso: 'NG', name: 'Nigeria', dialCode: '+234' },
  { iso: 'KE', name: 'Kenya', dialCode: '+254' },
  { iso: 'ZA', name: 'South Africa', dialCode: '+27' },
  { iso: 'US', name: 'United States', dialCode: '+1' },
  { iso: 'CA', name: 'Canada', dialCode: '+1' },
  { iso: 'GB', name: 'United Kingdom', dialCode: '+44' },
  { iso: 'IN', name: 'India', dialCode: '+91' },
  { iso: 'DE', name: 'Germany', dialCode: '+49' },
  { iso: 'FR', name: 'France', dialCode: '+33' },
  { iso: 'IT', name: 'Italy', dialCode: '+39' },
  { iso: 'ES', name: 'Spain', dialCode: '+34' },
  { iso: 'AE', name: 'United Arab Emirates', dialCode: '+971' },
  { iso: 'SA', name: 'Saudi Arabia', dialCode: '+966' },
];

const COUNTRY_DIAL_CODE_BY_ISO: Record<string, string> = {
  GH: '+233',
  US: '+1',
  CA: '+1',
  GB: '+44',
  NG: '+234',
  KE: '+254',
  ZA: '+27',
  IN: '+91',
  DE: '+49',
  FR: '+33',
  IT: '+39',
  ES: '+34',
  AE: '+971',
  SA: '+966',
};

function digitsOnly(value: string): string {
  return value.replace(/\D/g, '');
}

export function getDialCodeFromCountry(countryCode?: string): string | null {
  if (!countryCode) return null;
  return COUNTRY_DIAL_CODE_BY_ISO[countryCode.trim().toUpperCase()] || null;
}

export function getCountryOption(iso?: string): PhoneCountryOption | null {
  if (!iso) return null;
  return PHONE_COUNTRIES.find((country) => country.iso === iso.trim().toUpperCase()) || null;
}

export function normalizePhoneForCountry(rawPhone: string, countryCode?: string): string | null {
  const input = rawPhone.trim();
  if (!input) return null;

  if (input.startsWith('+')) {
    const normalized = `+${digitsOnly(input)}`;
    return normalized;
  }

  const dialCode = getDialCodeFromCountry(countryCode);
  if (!dialCode) return null;

  const localDigits = digitsOnly(input).replace(/^0+/, '');
  if (!localDigits) return null;

  return `${dialCode}${localDigits}`;
}

export function isLikelyE164(phone: string): boolean {
  return /^\+[1-9]\d{7,14}$/.test(phone);
}
