/**
 * Printer hooks for UI.
 */

import { useSyncExternalStore, useCallback } from "react";
import { subscribePrinter, getPrinterSnapshot, setDefaultPrinter, setAutoPrint, addPrinter, updatePrinter, removePrinter, hydratePrinterStore } from "./store";
import { getMdnsAdapter } from "../adapters/print";
import { printerService } from "./service";
import type { SellerOrder } from "../types/api/seller.api";
import { useEffect, useState } from "react";

export function usePrinter() {
  const state = useSyncExternalStore(subscribePrinter, getPrinterSnapshot, getPrinterSnapshot);
  useEffect(() => { void hydratePrinterStore(); }, []);
  return {
    ...state,
    setDefaultPrinter,
    setAutoPrint,
    addPrinter,
    updatePrinter,
    removePrinter,
  };
}

export function usePrintOrder() {
  const [printing, setPrinting] = useState(false);
  const print = useCallback(async (order: SellerOrder) => {
    setPrinting(true);
    try {
      await printerService.printOrderReceipt(order);
    } finally {
      setPrinting(false);
    }
  }, []);
  return { print, printing };
}

export function useDiscoverPrinters() {
  const [discovering, setDiscovering] = useState(false);
  const [printers, setPrinters] = useState<{ name: string; ip: string; port: number }[]>([]);
  const discover = useCallback(async (timeoutMs = 8000) => {
    setDiscovering(true);
    try {
      const mdns = getMdnsAdapter();
      if (mdns?.discoverPrinters) {
        const found = await mdns.discoverPrinters(timeoutMs);
        setPrinters(found);
        return found;
      }
      return [];
    } finally {
      setDiscovering(false);
    }
  }, []);
  return { printers, discovering, discover };
}
