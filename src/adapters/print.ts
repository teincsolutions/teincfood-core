/**
 * Print adapters — host injects platform-specific implementations.
 */

export interface TcpSocketAdapter {
  sendToTcpPrinter(ip: string, port: number, text: string): Promise<void>;
}

export interface PrintFileAdapter {
  printToFileAsync(html: string): Promise<{ uri: string }>;
  isSharingAvailable?(): Promise<boolean>;
  shareAsync?(uri: string, options?: { dialogTitle?: string; mimeType?: string }): Promise<void>;
}

export interface MdnsAdapter {
  discoverPrinters?(timeoutMs?: number): Promise<{ name: string; ip: string; port: number }[]>;
}

let tcpAdapter: TcpSocketAdapter | null = null;
let printFileAdapter: PrintFileAdapter | null = null;
let mdnsAdapter: MdnsAdapter | null = null;

export function setTcpAdapter(a: TcpSocketAdapter | null): void { tcpAdapter = a; }
export function getTcpAdapter(): TcpSocketAdapter | null { return tcpAdapter; }
export function setPrintFileAdapter(a: PrintFileAdapter | null): void { printFileAdapter = a; }
export function getPrintFileAdapter(): PrintFileAdapter | null { return printFileAdapter; }
export function setMdnsAdapter(a: MdnsAdapter | null): void { mdnsAdapter = a; }
export function getMdnsAdapter(): MdnsAdapter | null { return mdnsAdapter; }
