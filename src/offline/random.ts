/** Shared secure-random provider for offline keys, nonces and PIN salts. */

let provider: ((length: number) => Uint8Array) | null = null;

export function setOfflineRandomBytesProvider(
  next: ((length: number) => Uint8Array) | null,
): void {
  provider = next;
}

export function offlineRandomBytes(length: number): Uint8Array {
  if (provider) return provider(length);
  const cryptoObj = (globalThis as unknown as {
    crypto?: { getRandomValues?: (array: Uint8Array) => Uint8Array };
  }).crypto;
  if (cryptoObj?.getRandomValues) {
    return cryptoObj.getRandomValues(new Uint8Array(length));
  }
  throw new Error("No secure random source available. Call setOfflineRandomBytesProvider().");
}
