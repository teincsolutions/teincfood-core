/**
 * Offline device activation, license refresh and token exchange.
 *
 * One backend call activates a terminal while online. After that the app can
 * verify the signed license, unlock enrolled members locally, and only needs
 * the network to exchange the device challenge for fresh session tokens.
 */

import { getAppInstanceIdAsync, getDeviceMetadata } from "../adapters/devices";
import { getHttpClient } from "../adapters/http";
import { getAuthToken } from "../adapters/auth";
import { getConnectivityState } from "../adapters/connectivity";
import {
  MembershipRevokedError,
  isMembershipRevocationStatus,
} from "../membership/validation";
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
  updateOfflineMemberPin,
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

interface OfflineActivationBaseArgs {
  businessId: string;
  appInstanceId?: string;
  platform?: string;
  deviceName?: string;
  osVersion?: string;
  appVersion?: string;
}

/**
 * Activate the terminal license without creating any member PIN. The backend
 * activation also enrolls the signed-in user, but the quick-login PIN is a
 * separate, optional local credential.
 */
export async function activateOfflineLicense(
  args: OfflineActivationBaseArgs,
): Promise<OfflineActivationResult> {
  if (!getAuthToken()) throw new Error("Sign in online before activating this device");

  const deviceId = args.appInstanceId ?? (await getAppInstanceIdAsync());
  const metadata = await getDeviceMetadata();
  const keypair = await generateOfflineDeviceKeypair(randomBytes);

  const response = await getHttpClient().post<{
    data: OfflineActivationResult;
  }>(`/businesses/${args.businessId}/devices/${encodeURIComponent(deviceId)}/activate`, {
    device_public_key: keypair.publicKeyB64,
    app_instance_id: deviceId,
    platform: args.platform ?? metadata.platform ?? "unknown",
    device_name: args.deviceName ?? metadata.deviceName ?? undefined,
    os_version: args.osVersion ?? metadata.osVersion ?? undefined,
    app_version: args.appVersion ?? metadata.appVersion ?? undefined,
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

  return { ...data, payload: verified };
}

/**
 * First-time activation plus the optional local quick-login PIN. Kept as the
 * mobile-compatible entry point; desktop can call activateOfflineLicense()
 * first and set the PIN later.
 */
export async function activateOfflineDevice(
  args: OfflineActivationBaseArgs & {
    member: {
      userId: string;
      fullName: string;
      email?: string | null;
      role: string;
      capabilities: string[];
    };
    pin: string;
  },
): Promise<OfflineActivationResult> {
  const result = await activateOfflineLicense(args);

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
    deviceId: args.appInstanceId,
    userId: args.member.userId,
  }).catch((error) => {
    syncLogger.warn("OfflineAuth", "Member enrollment call failed", {
      error: String(error),
    });
  });

  return result;
}

/**
 * Set or change the local 6-digit quick-login PIN. Existing PINs must be
 * confirmed first; changing a PIN never requires the network.
 */
export async function setOfflineMemberPin(args: {
  businessId: string;
  userId: string;
  newPin: string;
  currentPin?: string;
  member?: {
    fullName: string;
    email?: string | null;
    role: string;
    capabilities: string[];
  };
}): Promise<OfflineMemberCredential> {
  if (!/^\d{6}$/.test(args.newPin)) {
    throw new Error("Offline PIN must be exactly 6 digits");
  }

  const existing = await getOfflineMember(args.userId, args.businessId);
  if (existing) {
    if (existing.pin_hash) {
      if (!args.currentPin) {
        throw new Error("Enter your current 6-digit PIN");
      }
      const valid = await verifyOfflineMemberPin(
        args.userId,
        args.currentPin,
        args.businessId,
      );
      if (!valid) throw new Error("Current PIN is incorrect");
    }
    await updateOfflineMemberPin(args.userId, args.businessId, args.newPin);
    const updated = await getOfflineMember(args.userId, args.businessId);
    if (!updated) throw new Error("Could not update the offline PIN");
    return updated;
  }

  if (!args.member) {
    throw new Error("Sign in online once before setting up an offline PIN");
  }

  return createOfflineMemberCredential({
    businessId: args.businessId,
    userId: args.userId,
    fullName: args.member.fullName,
    email: args.member.email,
    role: args.member.role,
    capabilities: args.member.capabilities,
    pin: args.newPin,
  });
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

/**
 * Best-effort presence heartbeat. Updates the admin dashboard's last-seen and
 * online state. Transient failures are swallowed; an explicit 401/403/404 is
 * surfaced as MembershipRevokedError so the host app can log the user out.
 */
export async function sendOfflineDeviceHeartbeat(
  businessId: string,
  overrides: { deviceName?: string; platform?: string; osVersion?: string; appVersion?: string } = {},
): Promise<void> {
  if (!getAuthToken()) return;
  const connectivity = getConnectivityState();
  if (!connectivity.isOnline || connectivity.isCloudReachable === "unreachable") return;

  try {
    const deviceId = await getAppInstanceIdAsync();
    const metadata = await getDeviceMetadata();
    await getHttpClient().patch(
      `/businesses/${businessId}/devices/${encodeURIComponent(deviceId)}/heartbeat`,
      {
        device_name: overrides.deviceName ?? metadata.deviceName ?? undefined,
        platform: overrides.platform ?? metadata.platform ?? undefined,
        os_version: overrides.osVersion ?? metadata.osVersion ?? undefined,
        app_version: overrides.appVersion ?? metadata.appVersion ?? undefined,
      },
    );
  } catch (error) {
    const status =
      error && typeof error === "object" && "status" in error
        ? (error as { status?: unknown }).status
        : undefined;
    if (isMembershipRevocationStatus(status)) {
      syncLogger.warn("OfflineAuth", "Device heartbeat reports revoked membership", {
        businessId,
        status,
      });
      throw new MembershipRevokedError(businessId, error);
    }
    syncLogger.debug("OfflineAuth", "Device heartbeat failed", { error: String(error) });
  }
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
