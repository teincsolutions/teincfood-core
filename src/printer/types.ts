export interface PrinterConfig {
  id: string;
  name: string;
  ip: string;
  port: number;
  type: "tcp" | "bluetooth";
}

export interface PrinterState {
  defaultPrinterId: string | null;
  printers: PrinterConfig[];
  autoPrint: boolean;
}
