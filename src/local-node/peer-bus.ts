/**
 * Peer request bus.
 *
 * `reference/service.ts` needs to ask the LAN mesh for missed reference data
 * and image bytes, while `local-node/service.ts` owns the live peer clients.
 * A tiny registry avoids a module cycle between those two services.
 */

import type { ReferenceDataKey, ReferenceDataRecord } from "../reference/types";

export interface LanAssetResult {
  url: string;
  base64: string | null;
  contentType?: string | null;
  error?: string | null;
}

type ReferenceFetcher = (
  businessId: string,
  keys: ReferenceDataKey[],
) => Promise<{ data: Partial<Record<ReferenceDataKey, ReferenceDataRecord | null>> }>;

type AssetFetcher = (businessId: string, url: string) => Promise<LanAssetResult | null>;

let referenceFetcher: ReferenceFetcher | null = null;
let assetFetcher: AssetFetcher | null = null;

export function registerLocalNodePeerBus(bus: {
  requestReference?: ReferenceFetcher;
  requestAsset?: AssetFetcher;
}): void {
  referenceFetcher = bus.requestReference ?? null;
  assetFetcher = bus.requestAsset ?? null;
}

export async function requestReferenceFromPeer(
  businessId: string,
  keys: ReferenceDataKey[],
): Promise<{ data: Partial<Record<ReferenceDataKey, ReferenceDataRecord | null>> } | null> {
  if (!referenceFetcher) return null;
  try {
    return await referenceFetcher(businessId, keys);
  } catch {
    return null;
  }
}

export async function requestAssetFromPeer(
  businessId: string,
  url: string,
): Promise<LanAssetResult | null> {
  if (!assetFetcher) return null;
  try {
    return await assetFetcher(businessId, url);
  } catch {
    return null;
  }
}
