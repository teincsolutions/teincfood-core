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
} from "./types";

interface DataWrapper<T> {
  data: T;
}

export async function fetchReferenceVersions(
  businessId: string,
): Promise<ReferenceVersionInfo[]> {
  const response = await api.get<DataWrapper<ReferenceVersionInfo[]>>(
    `/businesses/${businessId}/reference-versions`,
  );
  return (response.data as DataWrapper<ReferenceVersionInfo[]>).data;
}

export async function fetchReferenceData(
  businessId: string,
  keys: ReferenceDataKey[],
): Promise<Record<ReferenceDataKey, unknown>> {
  const response = await api.get<DataWrapper<Record<ReferenceDataKey, unknown>>>(
    `/businesses/${businessId}/reference-data`,
    { params: { keys: keys.join(",") } },
  );
  return (response.data as DataWrapper<Record<ReferenceDataKey, unknown>>).data;
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
