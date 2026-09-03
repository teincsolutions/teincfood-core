/**
 * Filesystem adapter — host injects expo-file-system / Tauri fs
 */

export interface FileSystemAdapter {
  getInfoAsync(path: string): Promise<{ exists: boolean; isDirectory?: boolean }>;
  makeDirectoryAsync(path: string, opts?: { intermediates?: boolean }): Promise<void>;
  downloadAsync(url: string, fileUri: string): Promise<{ uri: string }>;
  deleteAsync(path: string, opts?: { idempotent?: boolean }): Promise<void>;
  readDirectoryAsync(path: string): Promise<string[]>;
  getDocumentDirectory(): string;
}

let fsAdapter: FileSystemAdapter | null = null;
export function setFileSystemAdapter(a: FileSystemAdapter | null): void { fsAdapter = a; }
export function getFileSystemAdapter(): FileSystemAdapter | null { return fsAdapter; }
