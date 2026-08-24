/**
 * Client-side UUID generation — plain JS, no expo-crypto.
 */

function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(arr);
  } else {
    for (let i = 0; i < bytes; i++) arr[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

function uuidV4(): string {
  const hex = randomHex(16);
  // Set version 4 and variant bits per RFC4122
  return (
    hex.slice(0, 8) +
    "-" +
    hex.slice(8, 12) +
    "-" +
    "4" +
    hex.slice(13, 16) +
    "-" +
    ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16) +
    hex.slice(17, 20) +
    "-" +
    hex.slice(20, 32)
  );
}

export function generateUUID(): string {
  return uuidV4();
}

export function generateCommandId(): string {
  return `cmd_${uuidV4()}`;
}

export function generateEventId(): string {
  return `evt_${uuidV4()}`;
}

export function generateEntityId(): string {
  return uuidV4();
}
