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
  LICENSE: "offline:license",
  PUBLIC_KEY: "offline:license:public_key",
  KEY_ID: "offline:license:key_id",
  MEMBERS: "offline:members",
  DEVICE_PRIVATE_KEY: "offline:device:private_key",
} as const;

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

export async function getStoredLicense(): Promise<string | null> {
  return getItem<string>(OFFLINE_STORAGE_KEYS.LICENSE);
}

export async function saveStoredLicense(token: string): Promise<void> {
  await setItem(OFFLINE_STORAGE_KEYS.LICENSE, token);
}

export async function getStoredLicensePublicKey(): Promise<string | null> {
  return getItem<string>(OFFLINE_STORAGE_KEYS.PUBLIC_KEY);
}

export async function saveStoredLicensePublicKey(publicKey: string): Promise<void> {
  await setItem(OFFLINE_STORAGE_KEYS.PUBLIC_KEY, publicKey);
}

export async function getStoredLicenseKeyId(): Promise<string | null> {
  return getItem<string>(OFFLINE_STORAGE_KEYS.KEY_ID);
}

export async function saveStoredLicenseKeyId(keyId: string): Promise<void> {
  await setItem(OFFLINE_STORAGE_KEYS.KEY_ID, keyId);
}

export interface OfflineMemberCredential {
  user_id: string;
  full_name: string;
  email?: string | null;
  role: string;
  capabilities: string[];
  pin_salt: string;
  pin_hash: string;
  enrolled_at: string;
  last_login_at?: string | null;
}

export async function listOfflineMembers(): Promise<OfflineMemberCredential[]> {
  return (await getItem<OfflineMemberCredential[]>(OFFLINE_STORAGE_KEYS.MEMBERS)) ?? [];
}

export async function getOfflineMember(userId: string): Promise<OfflineMemberCredential | null> {
  const members = await listOfflineMembers();
  return members.find((member) => member.user_id === userId) ?? null;
}

export async function saveOfflineMember(member: OfflineMemberCredential): Promise<void> {
  const members = await listOfflineMembers();
  const next = members.filter((existing) => existing.user_id !== member.user_id);
  next.push(member);
  await setItem(OFFLINE_STORAGE_KEYS.MEMBERS, next);
}

export async function removeOfflineMember(userId: string): Promise<void> {
  const members = await listOfflineMembers();
  await setItem(
    OFFLINE_STORAGE_KEYS.MEMBERS,
    members.filter((member) => member.user_id !== userId),
  );
}

export async function markOfflineMemberLogin(userId: string): Promise<void> {
  const member = await getOfflineMember(userId);
  if (!member) return;
  await saveOfflineMember({ ...member, last_login_at: new Date().toISOString() });
}

export async function clearOfflineDevice(): Promise<void> {
  await Promise.all([
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

export async function verifyOfflineMemberPin(userId: string, pin: string): Promise<boolean> {
  const member = await getOfflineMember(userId);
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
