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
import {
  accountScopedKey,
  accountScopedKeyFor,
  getAccountScope,
} from "../session/account-scope";
import { sha256Hex } from "../reference/entitlement-crypto";
import { offlineRandomBytes } from "./random";

const scopedKey = (key: string) => accountScopedKey(key);

export const OFFLINE_STORAGE_KEYS = {
  /** Business-id keyed map: { [businessId]: { token, public_key, key_id } } */
  LICENSES: "offline:licenses",
  // Legacy single-license keys, retained only for migration.
  LICENSE: "offline:license",
  PUBLIC_KEY: "offline:license:public_key",
  KEY_ID: "offline:license:key_id",
  MEMBERS: "offline:members",
  DEVICE_PRIVATE_KEY: "offline:device:private_key",
  /** Device-level index: { [businessId]: accountId[] } used by revocation. */
  DEVICE_ACCOUNTS: "offline:device:accounts",
} as const;

export interface OfflineLicenseRecord {
  token: string;
  public_key: string;
  key_id: string;
  saved_at: string;
}

type OfflineLicenseMap = Record<string, OfflineLicenseRecord>;

async function getLicenseMap(): Promise<OfflineLicenseMap> {
  return (await getItem<OfflineLicenseMap>(scopedKey(OFFLINE_STORAGE_KEYS.LICENSES))) ?? {};
}

async function getLicenseRecord(businessId?: string): Promise<OfflineLicenseRecord | null> {
  const map = await getLicenseMap();
  if (businessId && map[businessId]) return map[businessId];
  if (!businessId) {
    const first = Object.values(map)[0];
    if (first) return first;
  }

  return null;
}

async function readDeviceAccountIndex(): Promise<Record<string, string[]>> {
  return (
    (await getItem<Record<string, string[]>>(
      OFFLINE_STORAGE_KEYS.DEVICE_ACCOUNTS,
    )) ?? {}
  );
}

async function writeDeviceAccountIndex(
  index: Record<string, string[]>,
): Promise<void> {
  await setItem(OFFLINE_STORAGE_KEYS.DEVICE_ACCOUNTS, index);
  if (Object.keys(index).length === 0) {
    await removeDevicePrivateKey().catch(() => undefined);
  }
}

async function registerOfflineAccountForBusiness(
  accountId: string | null,
  businessId: string,
): Promise<void> {
  if (!accountId || !businessId) return;
  const index = await readDeviceAccountIndex();
  const accounts = new Set(index[businessId] ?? []);
  accounts.add(accountId);
  index[businessId] = [...accounts];
  await writeDeviceAccountIndex(index);
}

async function unregisterOfflineAccountForBusiness(
  accountId: string,
  businessId: string,
): Promise<void> {
  const index = await readDeviceAccountIndex();
  const accounts = (index[businessId] ?? []).filter((id) => id !== accountId);
  if (accounts.length) index[businessId] = accounts;
  else delete index[businessId];
  await writeDeviceAccountIndex(index);
}

async function unregisterOfflineBusiness(businessId: string): Promise<void> {
  const index = await readDeviceAccountIndex();
  if (!(businessId in index)) return;
  delete index[businessId];
  await writeDeviceAccountIndex(index);
}

async function propagateLicenseRecord(
  businessId: string,
  record: OfflineLicenseRecord,
): Promise<void> {
  const current = getAccountScope();
  const index = await readDeviceAccountIndex();
  for (const accountId of index[businessId] ?? []) {
    if (accountId === current) continue;
    const key = accountScopedKeyFor(accountId, OFFLINE_STORAGE_KEYS.LICENSES);
    const map = (await getItem<OfflineLicenseMap>(key)) ?? {};
    map[businessId] = record;
    await setItem(key, map);
  }
}

async function writeMemberToAccount(
  accountId: string,
  businessId: string,
  member: OfflineMemberCredential | null,
  userId?: string,
): Promise<void> {
  const key = accountScopedKeyFor(accountId, OFFLINE_STORAGE_KEYS.MEMBERS);
  const all = (await getItem<OfflineMemberCredential[]>(key)) ?? [];
  const targetUserId = member?.user_id ?? userId;
  if (!targetUserId) return;
  const next = all.filter(
    (existing) =>
      existing.user_id !== targetUserId ||
      existing.business_id !== businessId,
  );
  if (member) next.push(member);
  if (next.length !== all.length || member) {
    await setItem(key, next);
  }
}

async function propagateMemberToCopies(
  member: OfflineMemberCredential,
  remove = false,
): Promise<void> {
  if (!member.business_id) return;
  const current = getAccountScope();
  const index = await readDeviceAccountIndex();
  for (const accountId of index[member.business_id] ?? []) {
    if (accountId === current) continue;
    await writeMemberToAccount(
      accountId,
      member.business_id,
      remove ? null : member,
      member.user_id,
    );
  }
}

async function saveLicenseRecord(businessId: string, record: OfflineLicenseRecord): Promise<void> {
  const map = await getLicenseMap();
  map[businessId] = record;
  await setItem(scopedKey(OFFLINE_STORAGE_KEYS.LICENSES), map);
  await registerOfflineAccountForBusiness(getAccountScope(), businessId);
  // Keep every member's copied license current after renewal/activation.
  await propagateLicenseRecord(businessId, record);
  // Drop legacy singletons once a scoped record exists.
  await Promise.all([
    removeItem(scopedKey(OFFLINE_STORAGE_KEYS.LICENSE)),
    removeItem(scopedKey(OFFLINE_STORAGE_KEYS.PUBLIC_KEY)),
    removeItem(scopedKey(OFFLINE_STORAGE_KEYS.KEY_ID)),
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
  await setItem(scopedKey(OFFLINE_STORAGE_KEYS.LICENSES), map);
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
  failed_attempts?: number;
  locked_until?: string | null;
}

function memberMatchesBusiness(member: OfflineMemberCredential, businessId?: string): boolean {
  if (!businessId) return true;
  // Account-scoped stores only contain credentials written by this version.
  // Require an exact business match so two businesses on one account cannot
  // read each other's team members.
  return member.business_id === businessId;
}

export async function listOfflineMembers(businessId?: string): Promise<OfflineMemberCredential[]> {
  const members = (await getItem<OfflineMemberCredential[]>(scopedKey(OFFLINE_STORAGE_KEYS.MEMBERS))) ?? [];
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
  const all = (await getItem<OfflineMemberCredential[]>(scopedKey(OFFLINE_STORAGE_KEYS.MEMBERS))) ?? [];
  const next = all.filter(
    (existing) =>
      existing.user_id !== member.user_id ||
      (existing.business_id ?? "") !== (member.business_id ?? ""),
  );
  next.push(member);
  await setItem(scopedKey(OFFLINE_STORAGE_KEYS.MEMBERS), next);
  if (member.business_id) {
    await registerOfflineAccountForBusiness(
      getAccountScope(),
      member.business_id,
    );
    // Role/capability/PIN changes must reach terminals that already hold a
    // copied credential for this member, not only the enrolling account.
    await propagateMemberToCopies(member);
  }
}

export async function removeOfflineMember(userId: string, businessId?: string): Promise<void> {
  const all = (await getItem<OfflineMemberCredential[]>(scopedKey(OFFLINE_STORAGE_KEYS.MEMBERS))) ?? [];
  await setItem(
    scopedKey(OFFLINE_STORAGE_KEYS.MEMBERS),
    all.filter((member) => {
      if (member.user_id !== userId) return true;
      return businessId ? member.business_id !== businessId : false;
    }),
  );
  if (!businessId) return;

  // A removed member must not keep a usable offline license in their own
  // account scope. Other copied accounts simply drop that member from their
  // team directory so they cannot unlock as the removed person.
  const current = getAccountScope();
  const index = await readDeviceAccountIndex();
  const accounts = new Set(index[businessId] ?? []);
  if (current) accounts.add(current);
  for (const accountId of accounts) {
    if (accountId === userId) {
      await removeOfflineBusinessFromAccount(accountId, businessId);
      await unregisterOfflineAccountForBusiness(accountId, businessId);
    } else if (accountId !== current) {
      await writeMemberToAccount(accountId, businessId, null, userId);
    }
  }
}

export async function markOfflineMemberLogin(userId: string, businessId?: string): Promise<void> {
  const member = await getOfflineMember(userId, businessId);
  if (!member) return;
  await saveOfflineMember({ ...member, last_login_at: new Date().toISOString() });
}

async function removeOfflineBusinessFromAccount(
  accountId: string,
  businessId: string,
): Promise<void> {
  const licenses =
    (await getItem<OfflineLicenseMap>(
      accountScopedKeyFor(accountId, OFFLINE_STORAGE_KEYS.LICENSES),
    )) ?? {};
  if (licenses[businessId]) {
    delete licenses[businessId];
    await setItem(
      accountScopedKeyFor(accountId, OFFLINE_STORAGE_KEYS.LICENSES),
      licenses,
    );
  }
  const members =
    (await getItem<OfflineMemberCredential[]>(
      accountScopedKeyFor(accountId, OFFLINE_STORAGE_KEYS.MEMBERS),
    )) ?? [];
  const remaining = members.filter(
    (member) => member.business_id !== businessId,
  );
  if (remaining.length !== members.length) {
    await setItem(
      accountScopedKeyFor(accountId, OFFLINE_STORAGE_KEYS.MEMBERS),
      remaining,
    );
  }
  // Legacy singletons were never business-keyed; drop them with the device.
  await Promise.all([
    removeItem(accountScopedKeyFor(accountId, OFFLINE_STORAGE_KEYS.LICENSE)),
    removeItem(accountScopedKeyFor(accountId, OFFLINE_STORAGE_KEYS.PUBLIC_KEY)),
    removeItem(accountScopedKeyFor(accountId, OFFLINE_STORAGE_KEYS.KEY_ID)),
  ]);
}

export async function clearOfflineDevice(businessId?: string): Promise<void> {
  const index =
    (await getItem<Record<string, string[]>>(
      OFFLINE_STORAGE_KEYS.DEVICE_ACCOUNTS,
    )) ?? {};

  if (businessId) {
    const accounts = new Set(index[businessId] ?? []);
    const current = getAccountScope();
    if (current) accounts.add(current);
    for (const accountId of accounts) {
      await removeOfflineBusinessFromAccount(accountId, businessId);
    }
    await unregisterOfflineBusiness(businessId);
    return;
  }

  for (const [indexedBusinessId, accounts] of Object.entries(index)) {
    for (const accountId of accounts) {
      await removeOfflineBusinessFromAccount(accountId, indexedBusinessId);
    }
  }
  await removeItem(OFFLINE_STORAGE_KEYS.DEVICE_ACCOUNTS);
  await Promise.all([
    removeItem(scopedKey(OFFLINE_STORAGE_KEYS.LICENSES)),
    removeItem(scopedKey(OFFLINE_STORAGE_KEYS.LICENSE)),
    removeItem(scopedKey(OFFLINE_STORAGE_KEYS.PUBLIC_KEY)),
    removeItem(scopedKey(OFFLINE_STORAGE_KEYS.KEY_ID)),
    removeItem(scopedKey(OFFLINE_STORAGE_KEYS.MEMBERS)),
    removeDevicePrivateKey().catch(() => undefined),
  ]);
}

/**
 * Copy the offline license + team directory for one business from the account
 * that activated the terminal to the account of a member signing in offline.
 *
 * Offline member sessions run under their own account scope (cart, chat and
 * SQLite stay isolated), so the device license must be present in that scope
 * before the session starts. Only this business's license and members are
 * copied — never the source account's other persisted data.
 */
export async function copyOfflineDeviceDataForAccount(args: {
  fromAccountId: string;
  toAccountId: string;
  businessId: string;
}): Promise<void> {
  const { fromAccountId, toAccountId, businessId } = args;
  if (!fromAccountId || !toAccountId || !businessId) return;
  if (fromAccountId === toAccountId) return;

  const fromLicenses =
    (await getItem<OfflineLicenseMap>(
      accountScopedKeyFor(fromAccountId, OFFLINE_STORAGE_KEYS.LICENSES),
    )) ?? {};
  const license = fromLicenses[businessId];
  if (!license) {
    throw new Error("Offline license not found for this device");
  }

  const toLicenses =
    (await getItem<OfflineLicenseMap>(
      accountScopedKeyFor(toAccountId, OFFLINE_STORAGE_KEYS.LICENSES),
    )) ?? {};
  toLicenses[businessId] = license;
  await setItem(
    accountScopedKeyFor(toAccountId, OFFLINE_STORAGE_KEYS.LICENSES),
    toLicenses,
  );

  const fromMembers =
    (await getItem<OfflineMemberCredential[]>(
      accountScopedKeyFor(fromAccountId, OFFLINE_STORAGE_KEYS.MEMBERS),
    )) ?? [];
  const businessMembers = fromMembers.filter(
    (member) => member.business_id === businessId,
  );
  const toMembers =
    (await getItem<OfflineMemberCredential[]>(
      accountScopedKeyFor(toAccountId, OFFLINE_STORAGE_KEYS.MEMBERS),
    )) ?? [];
  await setItem(
    accountScopedKeyFor(toAccountId, OFFLINE_STORAGE_KEYS.MEMBERS),
    [
      ...toMembers.filter((member) => member.business_id !== businessId),
      ...businessMembers,
    ],
  );
  await registerOfflineAccountForBusiness(fromAccountId, businessId);
  await registerOfflineAccountForBusiness(toAccountId, businessId);
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

/** Replace an existing member's PIN without changing their role/capabilities. */
export async function updateOfflineMemberPin(
  userId: string,
  businessId: string,
  pin: string,
): Promise<void> {
  if (!/^\d{6}$/.test(pin)) {
    throw new Error("Offline PIN must be exactly 6 digits");
  }
  const member = await getOfflineMember(userId, businessId);
  if (!member) throw new Error("This member has no offline credential on this device");
  const salt = randomHex(32);
  await saveOfflineMember({
    ...member,
    pin_salt: salt,
    pin_hash: await hashPin(pin, salt),
    failed_attempts: 0,
    locked_until: null,
  });
}

export const OFFLINE_PIN_MAX_ATTEMPTS = 5;

export interface OfflinePinLockState {
  failedAttempts: number;
  lockedUntil: string | null;
  locked: boolean;
  remainingAttempts: number;
}

export async function getOfflinePinLockState(
  userId: string,
  businessId?: string,
): Promise<OfflinePinLockState> {
  const member = await getOfflineMember(userId, businessId);
  const lockExpired = Boolean(
    member?.locked_until && new Date(member.locked_until).getTime() <= Date.now(),
  );
  const failedAttempts = lockExpired ? 0 : member?.failed_attempts ?? 0;
  const lockedUntil = lockExpired ? null : member?.locked_until ?? null;
  const locked = Boolean(lockedUntil && new Date(lockedUntil).getTime() > Date.now());
  return {
    failedAttempts,
    lockedUntil,
    locked,
    remainingAttempts: Math.max(OFFLINE_PIN_MAX_ATTEMPTS - failedAttempts, 0),
  };
}

export async function verifyOfflineMemberPin(
  userId: string,
  pin: string,
  businessId?: string,
): Promise<boolean> {
  const stored = await getOfflineMember(userId, businessId);
  if (!stored) return false;

  if (stored.locked_until && new Date(stored.locked_until).getTime() > Date.now()) {
    return false;
  }

  // An expired cooldown grants a fresh set of attempts.
  const member =
    stored.locked_until && new Date(stored.locked_until).getTime() <= Date.now()
      ? { ...stored, failed_attempts: 0, locked_until: null }
      : stored;

  if (!/^\d{6}$/.test(pin)) {
    await recordFailedPinAttempt(member);
    return false;
  }

  const candidate = await hashPin(pin, member.pin_salt);
  if (candidate.length !== member.pin_hash.length) {
    await recordFailedPinAttempt(member);
    return false;
  }

  let diff = 0;
  for (let i = 0; i < candidate.length; i++) {
    diff |= candidate.charCodeAt(i) ^ member.pin_hash.charCodeAt(i);
  }

  if (diff === 0) {
    if ((member.failed_attempts ?? 0) > 0 || member.locked_until) {
      await saveOfflineMember({ ...member, failed_attempts: 0, locked_until: null });
    }
    return true;
  }

  await recordFailedPinAttempt(member);
  return false;
}

async function recordFailedPinAttempt(member: OfflineMemberCredential): Promise<void> {
  const attempts = (member.failed_attempts ?? 0) + 1;
  const now = Date.now();
  const lockMs =
    attempts >= OFFLINE_PIN_MAX_ATTEMPTS
      ? Math.min(15 * 60_000, 60_000 * 2 ** (attempts - OFFLINE_PIN_MAX_ATTEMPTS))
      : 0;
  await saveOfflineMember({
    ...member,
    failed_attempts: attempts,
    locked_until: lockMs > 0 ? new Date(now + lockMs).toISOString() : null,
  });
}

/** Apply an offline role change to the local credential immediately. */
export async function updateOfflineMemberRole(
  userId: string,
  businessId: string,
  role: string,
  capabilities?: string[],
): Promise<void> {
  const member = await getOfflineMember(userId, businessId);
  if (!member) return;
  await saveOfflineMember({
    ...member,
    role,
    ...(capabilities ? { capabilities } : {}),
  });
}
