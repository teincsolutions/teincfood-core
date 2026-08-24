/**
 * Clipboard helper — no-op stub in core. Host apps inject real clipboard.
 */

let clipboardImpl: ((text: string) => Promise<void>) | null = null;

export function setClipboardImpl(fn: (text: string) => Promise<void>): void {
  clipboardImpl = fn;
}

export const copyToClipboard = async (text: string): Promise<void> => {
  if (clipboardImpl) {
    await clipboardImpl(text);
    return;
  }
  if (typeof navigator !== "undefined" && (navigator as unknown as { clipboard?: { writeText: (s: string) => Promise<void> } }).clipboard) {
    await (navigator as unknown as { clipboard: { writeText: (s: string) => Promise<void> } }).clipboard.writeText(text);
    return;
  }
  // fallback: no-op
};
