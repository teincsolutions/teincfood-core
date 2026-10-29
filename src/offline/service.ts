/**
 * Offline device activation, license refresh and token exchange.
 *
 * One backend call activates a terminal while online. After that the app can
 * verify the signed license, unlock enrolled members locally, and only needs
 * the network to exchange the device challenge for fresh session tokens.
 */

import { getAppInstanceIdAsync } from "../adapters/devices";
import { getHttpClient } from "../adapters/http";
import { getAuthToken } from "../adapters/auth";
import { syncLogger } from "../utils/sync-logger";
import { offlineRandomBytes } from "./random";
import {
  base64UrlDecode,
  base64UrlEncode,
  canonicalDeviceChallenge,
  decodeLicensePayload,
  evaluateOfflineLicense,
  generateOfflineDeviceKeypair,
  loadAndVerifyOfflineLicense,
  newOfflineNonce,
  signDeviceChallenge,
  verifyOfflineLicense,
  type OfflineLicenseEvaluation,
  type OfflineLicensePayload,
} from "./license";
import {
  clearOfflineDevice,
  createOfflineMemberCredential,
  getDevicePrivateKey,
  getOfflineMember,
  getStoredLicense,
  getStoredLicenseKeyId,
  getStoredLicensePublicKey,
  listOfflineMembers,
  markOfflineMemberLogin,
  removeOfflineMember,
  saveDevicePrivateKey,
  saveStoredLicense,
  saveStoredLicenseKeyId,
  saveStoredLicensePublicKey,
  verifyOfflineMemberPin,
  type OfflineMemberCredential,
} from "./store";

export interface OfflineActivationResult {
  license: string;
  public_key: string;
  key_id: string;
  license_payload: OfflineLicensePayload;
  algorithm?: string;
  device: Record<string, unknown>;
  /** Verified decoded payload (client-side convenience). */
  payload: OfflineLicensePayload;
}

export interface OfflineExchangeResult {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  license: string;
  license_payload: OfflineLicensePayload;
  public_key: string;
  key_id: string;
}

export interface OfflineSessionState {
  hasDevice: boolean;
  license: OfflineLicensePayload | null;
  evaluation: OfflineLicenseEvaluation;
  publicKey: string | null;
  keyId: string | null;
  members: OfflineMemberCredential[];
}

function randomBytes(length: number): Uint8Array {
  return offlineRandomBytes(length);
}

async function getPrivateKeyBytes(): Promise<Uint8Array | null> {
  const encoded = await getDevicePrivateKey();
  if (!encoded) return null;
  try {
    const raw = base64UrlDecode(encoded);
    return raw.length === 32 ? raw : null;
  } catch {
    return null;
  }
}

/**
 * First-time activation. Generates the device keypair, registers the public
 * key, stores the signed license and enrolls the current member's PIN.
 */
export async function activateOfflineDevice(args: {
  businessId: string;
  member: {
    userId: string;
    fullName: string;
    email?: string | null;
    role: string;
    capabilities: string[];
  };
  pin: string;
  appInstanceId?: string;
  platform?: string;
}): Promise<OfflineActivationResult> {
  if (!getAuthToken()) throw new Error("Sign in online before activating this device");

  const deviceId = args.appInstanceId ?? (await getAppInstanceIdAsync());
  const keypair = await generateOfflineDeviceKeypair(randomBytes);

  const response = await getHttpClient().post<{
    data: OfflineActivationResult;
  }>(`/businesses/${args.businessId}/devices/${encodeURIComponent(deviceId)}/activate`, {
    device_public_key: keypair.publicKeyB64,
    app_instance_id: deviceId,
    platform: args.platform ?? "unknown",
  });

  const data = response.data.data;
  if (!data?.license || !data.public_key) {
    throw new Error("Device activation returned no offline license");
  }

  const verified = await verifyOfflineLicense(data.license, data.public_key, args.businessId);
  if (!verified) throw new Error("Activation returned an invalid offline license");

  await saveDevicePrivateKey(base64UrlEncode(keypair.privateKey));
  await saveStoredLicense(args.businessId, data.license);
  await saveStoredLicensePublicKey(args.businessId, data.public_key);
  await saveStoredLicenseKeyId(args.businessId, data.key_id);

  await createOfflineMemberCredential({
    businessId: args.businessId,
    userId: args.member.userId,
    fullName: args.member.fullName,
    email: args.member.email,
    role: args.member.role,
    capabilities: args.member.capabilities,
    pin: args.pin,
  });

  // Best-effort: activation already enrolls the current member, but this makes
  // the intent explicit and is idempotent.
  await enrollMemberOnDevice({
    businessId: args.businessId,
    deviceId,
    userId: args.member.userId,
  }).catch((error) => {
    syncLogger.warn("OfflineAuth", "Member enrollment call failed", {
      error: String(error),
    });
  });

  return { ...data, payload: verified };
}

/** Refresh the signed license while online using the normal access token. */
export async function refreshOfflineLicense(businessId: string): Promise<OfflineActivationResult> {
  const deviceId = await getAppInstanceIdAsync();
  const response = await getHttpClient().post<{ data: OfflineActivationResult }>(
    `/businesses/${businessId}/devices/${encodeURIComponent(deviceId)}/license/refresh`,
  );
  const data = response.data.data;
  if (!data?.license || !data.public_key) {
    throw new Error("License refresh returned no license");
  }
  const verified = await verifyOfflineLicense(data.license, data.public_key, businessId);
  if (!verified) throw new Error("License refresh returned an invalid license");

  await saveStoredLicense(businessId, data.license);
  await saveStoredLicensePublicKey(businessId, data.public_key);
  await saveStoredLicenseKeyId(businessId, data.key_id);
  return { ...data, payload: verified };
}

/**
 * Reconnect path: sign a fresh nonce with the device key and exchange the
 * license for access/refresh tokens. Works even when the old refresh token
 * expired while the terminal was offline.
 */
export async function exchangeOfflineSession(args: {
  businessId: string;
  memberId: string;
  deviceId?: string;
}): Promise<OfflineExchangeResult> {
  const token = await getStoredLicense(args.businessId);
  const publicKey = await getStoredLicensePublicKey(args.businessId);
  const privateKey = await getPrivateKeyBytes();
  if (!token || !publicKey || !privateKey) {
    throw new Error("This device has no offline license");
  }

  const payload = await verifyOfflineLicense(token, publicKey, args.businessId);
  if (!payload) throw new Error("Stored offline license is invalid");

  const deviceId = args.deviceId ?? (await getAppInstanceIdAsync());
  const nonce = newOfflineNonce(randomBytes);
  const timestamp = new Date().toISOString();
  const message = canonicalDeviceChallenge({
    deviceId,
    licenseId: payload.license_id,
    memberId: args.memberId,
    nonce,
    timestamp,
  });
  const signature = await signDeviceChallenge(privateKey, message);

  const response = await getHttpClient().post<{ data: OfflineExchangeResult }>(
    "/auth/offline/exchange",
    {
      license: token,
      device_uuid: deviceId,
      member_id: args.memberId,
      nonce,
      timestamp,
      signature,
    },
  );

  const data = response.data.data;
  if (!data?.access_token || !data?.license) {
    throw new Error("Offline exchange returned no tokens");
  }

  const refreshed = await verifyOfflineLicense(
    data.license,
    data.public_key,
    args.businessId,
  );
  if (!refreshed) throw new Error("Offline exchange returned an invalid license");

  await saveStoredLicense(args.businessId, data.license);
  await saveStoredLicensePublicKey(args.businessId, data.public_key);
  await saveStoredLicenseKeyId(args.businessId, data.key_id);
  await markOfflineMemberLogin(args.memberId, args.businessId);

  return { ...data, license_payload: refreshed };
}

/** Read local license/member state without touching the network. */
export async function getOfflineSessionState(
  businessId?: string,
): Promise<OfflineSessionState> {
  const [token, publicKey, keyId, members] = await Promise.all([
    getStoredLicense(businessId),
    getStoredLicensePublicKey(businessId),
    getStoredLicenseKeyId(businessId),
    listOfflineMembers(businessId),
  ]);

  const { payload, evaluation } = await loadAndVerifyOfflineLicense({
    token,
    publicKey,
    businessId,
  });

  return {
    hasDevice: Boolean(token && publicKey),
    license: payload,
    evaluation,
    publicKey,
    keyId,
    members,
  };
}

export async function verifyOfflineLogin(
  userId: string,
  pin: string,
  businessId?: string,
): Promise<OfflineMemberCredential | null> {
  const member = await getOfflineMember(userId, businessId);
  if (!member) return null;
  const ok = await verifyOfflineMemberPin(userId, pin, businessId);
  if (!ok) return null;
  await markOfflineMemberLogin(userId, businessId);
  return member;
}

export async function enrollMemberOnDevice(args: {
  businessId: string;
  deviceId?: string;
  userId: string;
}): Promise<void> {
  const deviceId = args.deviceId ?? (await getAppInstanceIdAsync());
  await getHttpClient().post(
    `/businesses/${args.businessId}/devices/${encodeURIComponent(deviceId)}/members/${encodeURIComponent(args.userId)}/enroll`,
  );
}

export async function revokeMemberOnDevice(args: {
  businessId: string;
  deviceId?: string;
  userId: string;
}): Promise<void> {
  const deviceId = args.deviceId ?? (await getAppInstanceIdAsync());
  await getHttpClient().delete(
    `/businesses/${args.businessId}/devices/${encodeURIComponent(deviceId)}/members/${encodeURIComponent(args.userId)}`,
  );
  await removeOfflineMember(args.userId, args.businessId);
}

/** Owner action: revoke the terminal and wipe all local offline credentials. */
export async function removeOfflineDevice(businessId: string, reason?: string): Promise<void> {
  const deviceId = await getAppInstanceIdAsync();
  try {
    await getHttpClient().post(
      `/businesses/${businessId}/devices/${encodeURIComponent(deviceId)}/revoke`,
      { reason: reason ?? "removed_from_device" },
    );
  } catch (error) {
    syncLogger.warn("OfflineAuth", "Device revoke call failed; clearing locally", {
      error: String(error),
    });
  }
  await clearOfflineDevice(businessId);
}

export async function getStoredOfflineLicensePayload(
  businessId?: string,
): Promise<OfflineLicensePayload | null> {
  const token = await getStoredLicense(businessId);
  return token ? decodeLicensePayload(token) : null;
}

export async function evaluateStoredOfflineLicense(
  businessId?: string,
): Promise<OfflineLicenseEvaluation> {
  const state = await getOfflineSessionState(businessId);
  return state.evaluation;
}

export { evaluateOfflineLicense };
