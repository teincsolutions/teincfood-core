/**
 * Offline license + member credential storage.
 *
 * The device private key must live in host secure storage (Keychain /
 * Keystore / Tauri stronghold). The signed license, public key and member
 * directory are non-secret and live in the shared KV store.
 *
 * Member PINs are stored as slow salted hashes. We never store the member's
 * server password or its hash.
 */

import { getItem, removeItem, setItem } from "../adapters/kv";
import { sha256Hex } from "../reference/entitlement-crypto";
import { offlineRandomBytes } from "./random";

export const OFFLINE_STORAGE_KEYS = {
  /** Business-id keyed map: { [businessId]: { token, public_key, key_id } } */
  LICENSES: "offline:licenses",
  // Legacy single-license keys, retained only for migration.
  LICENSE: "offline:license",
  PUBLIC_KEY: "offline:license:public_key",
  KEY_ID: "offline:license:key_id",
  MEMBERS: "offline:members",
  DEVICE_PRIVATE_KEY: "offline:device:private_key",
} as const;

export interface OfflineLicenseRecord {
  token: string;
  public_key: string;
  key_id: string;
  saved_at: string;
}

type OfflineLicenseMap = Record<string, OfflineLicenseRecord>;

async function getLicenseMap(): Promise<OfflineLicenseMap> {
  return (await getItem<OfflineLicenseMap>(OFFLINE_STORAGE_KEYS.LICENSES)) ?? {};
}

async function getLicenseRecord(businessId?: string): Promise<OfflineLicenseRecord | null> {
  const map = await getLicenseMap();
  if (businessId && map[businessId]) return map[businessId];
  if (!businessId) {
    const first = Object.values(map)[0];
    if (first) return first;
  }

  // Migration path from the original single-license build. Verification still
  // checks the business id inside the signed payload, so this cannot leak a
  // license into the wrong tenant.
  const [token, publicKey, keyId] = await Promise.all([
    getItem<string>(OFFLINE_STORAGE_KEYS.LICENSE),
    getItem<string>(OFFLINE_STORAGE_KEYS.PUBLIC_KEY),
    getItem<string>(OFFLINE_STORAGE_KEYS.KEY_ID),
  ]);
  if (token && publicKey) {
    return { token, public_key: publicKey, key_id: keyId ?? "", saved_at: new Date().toISOString() };
  }
  return null;
}

async function saveLicenseRecord(businessId: string, record: OfflineLicenseRecord): Promise<void> {
  const map = await getLicenseMap();
  map[businessId] = record;
  await setItem(OFFLINE_STORAGE_KEYS.LICENSES, map);
  // Drop legacy singletons once a scoped record exists.
  await Promise.all([
    removeItem(OFFLINE_STORAGE_KEYS.LICENSE),
    removeItem(OFFLINE_STORAGE_KEYS.PUBLIC_KEY),
    removeItem(OFFLINE_STORAGE_KEYS.KEY_ID),
  ]);
}

export async function getStoredLicense(businessId?: string): Promise<string | null> {
  return (await getLicenseRecord(businessId))?.token ?? null;
}

export async function saveStoredLicense(businessId: string, token: string): Promise<void> {
  const existing = await getLicenseRecord(businessId);
  await saveLicenseRecord(businessId, {
    token,
    public_key: existing?.public_key ?? "",
    key_id: existing?.key_id ?? "",
    saved_at: new Date().toISOString(),
  });
}

export async function getStoredLicensePublicKey(businessId?: string): Promise<string | null> {
  return (await getLicenseRecord(businessId))?.public_key ?? null;
}

export async function saveStoredLicensePublicKey(businessId: string, publicKey: string): Promise<void> {
  const existing = await getLicenseRecord(businessId);
  if (!existing) throw new Error("Save the signed license before its public key");
  await saveLicenseRecord(businessId, { ...existing, public_key: publicKey });
}

export async function getStoredLicenseKeyId(businessId?: string): Promise<string | null> {
  return (await getLicenseRecord(businessId))?.key_id ?? null;
}

export async function saveStoredLicenseKeyId(businessId: string, keyId: string): Promise<void> {
  const existing = await getLicenseRecord(businessId);
  if (!existing) throw new Error("Save the signed license before its key id");
  await saveLicenseRecord(businessId, { ...existing, key_id: keyId });
}

export async function listStoredLicenseBusinessIds(): Promise<string[]> {
  return Object.keys(await getLicenseMap());
}

export async function removeStoredLicense(businessId: string): Promise<void> {
  const map = await getLicenseMap();
  delete map[businessId];
  await setItem(OFFLINE_STORAGE_KEYS.LICENSES, map);
}

export interface OfflineSecureStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

let secureStorage: OfflineSecureStorage | null = null;

export function setOfflineSecureStorage(storage: OfflineSecureStorage | null): void {
  secureStorage = storage;
}

function secure(): OfflineSecureStorage {
  if (!secureStorage) {
    throw new Error(
      "Offline secure storage is not configured. Call setOfflineSecureStorage() at boot.",
    );
  }
  return secureStorage;
}

export async function getDevicePrivateKey(): Promise<string | null> {
  return secure().getItem(OFFLINE_STORAGE_KEYS.DEVICE_PRIVATE_KEY);
}

export async function saveDevicePrivateKey(privateKeyB64: string): Promise<void> {
  await secure().setItem(OFFLINE_STORAGE_KEYS.DEVICE_PRIVATE_KEY, privateKeyB64);
}

export async function removeDevicePrivateKey(): Promise<void> {
  await secure().removeItem(OFFLINE_STORAGE_KEYS.DEVICE_PRIVATE_KEY);
}

export interface OfflineMemberCredential {
  user_id: string;
  /** Business this offline credential is scoped to. */
  business_id?: string;
  full_name: string;
  email?: string | null;
  role: string;
  capabilities: string[];
  pin_salt: string;
  pin_hash: string;
  enrolled_at: string;
  last_login_at?: string | null;
}

function memberMatchesBusiness(member: OfflineMemberCredential, businessId?: string): boolean {
  if (!businessId) return true;
  // Pre-migration rows had no business_id; keep them visible until an online
  // activation rewrites them with the correct scope.
  return !member.business_id || member.business_id === businessId;
}

export async function listOfflineMembers(businessId?: string): Promise<OfflineMemberCredential[]> {
  const members = (await getItem<OfflineMemberCredential[]>(OFFLINE_STORAGE_KEYS.MEMBERS)) ?? [];
  return members.filter((member) => memberMatchesBusiness(member, businessId));
}

export async function getOfflineMember(
  userId: string,
  businessId?: string,
): Promise<OfflineMemberCredential | null> {
  const members = await listOfflineMembers(businessId);
  return members.find((member) => member.user_id === userId) ?? null;
}

export async function saveOfflineMember(member: OfflineMemberCredential): Promise<void> {
  const all = (await getItem<OfflineMemberCredential[]>(OFFLINE_STORAGE_KEYS.MEMBERS)) ?? [];
  const next = all.filter(
    (existing) =>
      existing.user_id !== member.user_id ||
      (existing.business_id ?? "") !== (member.business_id ?? ""),
  );
  next.push(member);
  await setItem(OFFLINE_STORAGE_KEYS.MEMBERS, next);
}

export async function removeOfflineMember(userId: string, businessId?: string): Promise<void> {
  const all = (await getItem<OfflineMemberCredential[]>(OFFLINE_STORAGE_KEYS.MEMBERS)) ?? [];
  await setItem(
    OFFLINE_STORAGE_KEYS.MEMBERS,
    all.filter((member) => {
      if (member.user_id !== userId) return true;
      return businessId ? member.business_id !== businessId : false;
    }),
  );
}

export async function markOfflineMemberLogin(userId: string, businessId?: string): Promise<void> {
  const member = await getOfflineMember(userId, businessId);
  if (!member) return;
  await saveOfflineMember({ ...member, last_login_at: new Date().toISOString() });
}

export async function clearOfflineDevice(businessId?: string): Promise<void> {
  if (businessId) {
    await removeStoredLicense(businessId);
    const all = (await getItem<OfflineMemberCredential[]>(OFFLINE_STORAGE_KEYS.MEMBERS)) ?? [];
    await setItem(
      OFFLINE_STORAGE_KEYS.MEMBERS,
      all.filter((member) => member.business_id !== businessId),
    );
    return;
  }
  await Promise.all([
    removeItem(OFFLINE_STORAGE_KEYS.LICENSES),
    removeItem(OFFLINE_STORAGE_KEYS.LICENSE),
    removeItem(OFFLINE_STORAGE_KEYS.PUBLIC_KEY),
    removeItem(OFFLINE_STORAGE_KEYS.KEY_ID),
    removeItem(OFFLINE_STORAGE_KEYS.MEMBERS),
    removeDevicePrivateKey().catch(() => undefined),
  ]);
}

const PIN_ROUNDS = 20_000;

function randomHex(length: number): string {
  const bytes = offlineRandomBytes(Math.ceil(length / 2));
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out.slice(0, length);
}

async function hashPin(pin: string, salt: string): Promise<string> {
  let digest = `${salt}:${pin}`;
  for (let i = 0; i < PIN_ROUNDS; i++) {
    digest = await sha256Hex(`${digest}:${salt}:${i}`);
  }
  return digest;
}

export async function createOfflineMemberCredential(args: {
  businessId: string;
  userId: string;
  fullName: string;
  email?: string | null;
  role: string;
  capabilities: string[];
  pin: string;
}): Promise<OfflineMemberCredential> {
  if (!/^\d{6}$/.test(args.pin)) {
    throw new Error("Offline PIN must be exactly 6 digits");
  }
  const salt = randomHex(32);
  const member: OfflineMemberCredential = {
    user_id: args.userId,
    business_id: args.businessId,
    full_name: args.fullName,
    email: args.email ?? null,
    role: args.role,
    capabilities: args.capabilities,
    pin_salt: salt,
    pin_hash: await hashPin(args.pin, salt),
    enrolled_at: new Date().toISOString(),
    last_login_at: null,
  };
  await saveOfflineMember(member);
  return member;
}

export async function verifyOfflineMemberPin(
  userId: string,
  pin: string,
  businessId?: string,
): Promise<boolean> {
  const member = await getOfflineMember(userId, businessId);
  if (!member) return false;
  if (!/^\d{6}$/.test(pin)) return false;
  const candidate = await hashPin(pin, member.pin_salt);
  if (candidate.length !== member.pin_hash.length) return false;
  let diff = 0;
  for (let i = 0; i < candidate.length; i++) {
    diff |= candidate.charCodeAt(i) ^ member.pin_hash.charCodeAt(i);
  }
  return diff === 0;
}
