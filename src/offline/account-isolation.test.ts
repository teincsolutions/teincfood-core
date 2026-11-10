import { beforeEach, describe, expect, it } from "vitest";
import { setKVDriver } from "../adapters/kv";
import {
  clearAll as clearCart,
  getCartSnapshot,
  hydrateCartStore,
  resetCartHydration,
} from "../cart/store";
import { setAccountScope } from "../session/account-scope";
import {
  clearOfflineDevice,
  copyOfflineDeviceDataForAccount,
  listOfflineMembers,
  removeOfflineMember,
  saveOfflineMember,
  saveStoredLicense,
  saveStoredLicenseKeyId,
  saveStoredLicensePublicKey,
  setOfflineSecureStorage,
  type OfflineMemberCredential,
} from "./store";

const A = "account-a";
const B = "account-b";
const C = "account-c";
const D = "account-d";
const X = "business-x";
const Y = "business-y";

let kv: Map<string, string>;
let secure: Map<string, string>;

beforeEach(() => {
  kv = new Map();
  secure = new Map();
  setAccountScope(null);
  setKVDriver({
    getItem: (key) => kv.get(key) ?? null,
    setItem: (key, value) => {
      kv.set(key, value);
    },
    removeItem: (key) => {
      kv.delete(key);
    },
    getItemSync: (key) => kv.get(key) ?? null,
    setItemSync: (key, value) => {
      kv.set(key, value);
    },
    removeItemSync: (key) => {
      kv.delete(key);
    },
  });
  setOfflineSecureStorage({
    getItem: async (key) => secure.get(key) ?? null,
    setItem: async (key, value) => {
      secure.set(key, value);
    },
    removeItem: async (key) => {
      secure.delete(key);
    },
  });
});

function member(
  userId: string,
  businessId = X,
  overrides: Partial<OfflineMemberCredential> = {},
): OfflineMemberCredential {
  return {
    user_id: userId,
    business_id: businessId,
    full_name: userId,
    email: null,
    role: "seller",
    capabilities: ["pos"],
    pin_salt: "salt",
    pin_hash: "hash-v1",
    enrolled_at: new Date().toISOString(),
    last_login_at: null,
    ...overrides,
  };
}

function licenseFor(accountId: string, businessId = X) {
  const raw = kv.get(
    `acct:${encodeURIComponent(accountId)}:offline:licenses`,
  );
  return raw ? (JSON.parse(raw)[businessId] ?? null) : null;
}

async function seedBusiness(): Promise<void> {
  setAccountScope(A);
  await saveStoredLicense(X, "token-v1");
  await saveStoredLicensePublicKey(X, "public-v1");
  await saveStoredLicenseKeyId(X, "kid-v1");
  await saveStoredLicense(Y, "token-y");
  await saveStoredLicensePublicKey(Y, "public-y");
  await saveStoredLicenseKeyId(Y, "kid-y");
  await saveOfflineMember(member(A));
  await saveOfflineMember(member(C));
}

describe("offline account isolation", () => {
  it("copies only the requested business and never writes unscoped credentials", async () => {
    await seedBusiness();

    await copyOfflineDeviceDataForAccount({
      fromAccountId: A,
      toAccountId: B,
      businessId: X,
    });

    setAccountScope(B);
    expect((await listOfflineMembers(X)).map((m) => m.user_id)).toEqual([
      A,
      C,
    ]);
    expect(await listOfflineMembers(Y)).toEqual([]);
    expect(licenseFor(B, X)?.token).toBe("token-v1");
    expect(licenseFor(B, Y)).toBeNull();

    expect(kv.has("offline:licenses")).toBe(false);
    expect(kv.has("offline:members")).toBe(false);
  });

  it("never persists a cart without an account or across accounts", async () => {
    setAccountScope(null);
    clearCart();
    expect(kv.has("Teinc Food-pos-cart")).toBe(false);

    setAccountScope(A);
    const aKey = `acct:${encodeURIComponent(A)}:Teinc Food-pos-cart`;
    kv.set(
      aKey,
      JSON.stringify({
        state: { items: [{ id: "a-item" }], checkoutForm: {} },
        version: 0,
      }),
    );
    resetCartHydration();
    await hydrateCartStore();
    expect(getCartSnapshot().items).toEqual([{ id: "a-item" }]);

    setAccountScope(B);
    await hydrateCartStore();
    expect(getCartSnapshot().items).toEqual([]);
    expect(kv.has("Teinc Food-pos-cart")).toBe(false);

    setAccountScope(A);
    await hydrateCartStore();
    expect(getCartSnapshot().items).toEqual([{ id: "a-item" }]);
  });

  it("propagates license/member updates and removes every account copy on revocation", async () => {
    await seedBusiness();
    await copyOfflineDeviceDataForAccount({
      fromAccountId: A,
      toAccountId: B,
      businessId: X,
    });
    await copyOfflineDeviceDataForAccount({
      fromAccountId: A,
      toAccountId: C,
      businessId: X,
    });

    // Owner renews the license and changes a member's PIN/role.
    setAccountScope(A);
    await saveStoredLicense(X, "token-v2");
    await saveStoredLicensePublicKey(X, "public-v2");
    await saveStoredLicenseKeyId(X, "kid-v2");
    await saveOfflineMember(
      member(C, X, { role: "manager", pin_hash: "hash-v2" }),
    );
    await saveOfflineMember(member(D, X));

    setAccountScope(B);
    expect(licenseFor(B, X)?.token).toBe("token-v2");
    expect(licenseFor(C, X)?.token).toBe("token-v2");
    const copied = await listOfflineMembers(X);
    expect(copied).toHaveLength(3);
    expect(copied.find((m) => m.user_id === C)).toMatchObject({
      role: "manager",
      pin_hash: "hash-v2",
    });

    // Removing a member strips their own license copy but keeps other
    // authorized accounts working.
    setAccountScope(A);
    await removeOfflineMember(C, X);
    setAccountScope(B);
    expect(
      (await listOfflineMembers(X)).some((m) => m.user_id === C),
    ).toBe(false);
    expect(licenseFor(B, X)).not.toBeNull();
    expect(licenseFor(C, X)).toBeNull();

    // Device revocation wipes every remaining account scope.
    await clearOfflineDevice(X);
    for (const accountId of [A, B, C]) {
      expect(licenseFor(accountId, X)).toBeNull();
    }
    expect(licenseFor(A, Y)?.token).toBe("token-y");
    expect(secure.has("offline:device:private_key")).toBe(false);
  });
});
