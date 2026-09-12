/**
 * API service for reference data synchronization.
 *
 * These endpoints are expected on the backend. If they are not available,
 * the ReferenceSyncService falls back to legacy menu endpoints.
 */

import { api } from "../adapters/http";
import type {
  ReferenceDataKey,
  ReferenceVersionInfo,
  ReferenceChangeSet,
  ReferenceDataRecord,
} from "./types";

interface DataWrapper<T> {
  data: T;
}

/**
 * Optional LAN supplier: when the cloud is unreachable (offline + connected to
 * a Local Node), the host app can serve cached reference data from the node via
 * the LAN instead of failing. Injected by the host (mobile/desktop) once at
 * bootstrap; null means no LAN reference path.
 */
export type ReferenceLocalNodeFetcher = (options: {
  businessId: string;
  keys: ReferenceDataKey[];
}) => Promise<Partial<Record<ReferenceDataKey, ReferenceDataRecord | null>>>;

let localNodeFetcher: ReferenceLocalNodeFetcher | null = null;

export function setReferenceLocalNodeFetcher(
  fetcher: ReferenceLocalNodeFetcher | null,
): void {
  localNodeFetcher = fetcher;
}

export async function fetchReferenceVersions(
  businessId: string,
): Promise<ReferenceVersionInfo[]> {
  const response = await api.get<DataWrapper<ReferenceVersionInfo[]>>(
    `/businesses/${businessId}/reference-versions`,
  );
  return (response.data as DataWrapper<ReferenceVersionInfo[]>).data;
}

/**
 * Fetch reference data for the requested keys. Falls back to the Local Node
 * (LAN) when the cloud call fails and a LAN fetcher is configured — so a
 * no-internet terminal can still converge after a `reference_data.changed`
 * event relayed over the LAN.
 */
export async function fetchReferenceData(
  businessId: string,
  keys: ReferenceDataKey[],
): Promise<Record<ReferenceDataKey, unknown>> {
  try {
    const response = await api.get<DataWrapper<Record<ReferenceDataKey, unknown>>>(
      `/businesses/${businessId}/reference-data`,
      { params: { keys: keys.join(",") } },
    );
    return (response.data as DataWrapper<Record<ReferenceDataKey, unknown>>).data;
  } catch (error) {
    if (!localNodeFetcher) throw error;
    const cached = await localNodeFetcher({ businessId, keys });
    const out: Record<ReferenceDataKey, unknown> = {} as Record<ReferenceDataKey, unknown>;
    for (const key of keys) {
      if (cached[key]?.payload != null) out[key] = cached[key]!.payload;
    }
    return out;
  }
}

export async function fetchReferenceChanges<T>(
  businessId: string,
  key: ReferenceDataKey,
  fromVersion: string,
): Promise<ReferenceChangeSet<T>> {
  const response = await api.get<DataWrapper<ReferenceChangeSet<T>>>(
    `/businesses/${businessId}/reference-changes`,
    { params: { key, from_version: fromVersion } },
  );
  return (response.data as DataWrapper<ReferenceChangeSet<T>>).data;
}

export { setReferenceData, mergeReferenceData } from "./operations";
export { setOperatingHoursLocal, setBusinessProfileLocal } from "./operations";
