/**
 * Command builder helpers.
 *
 * Centralizes creation of Command objects with consistent metadata
 * (command_id, user_id, device_id, timestamps).
 */

import type { Command } from "./types";
import { useAuthStore } from "../adapters/auth";
import { getAppInstanceId } from "../adapters/devices";
import { generateCommandId } from "../utils/uuid";

export interface CommandBuilderOptions<T> {
  commandType: string;
  commandVersion?: string;
  businessId: string;
  entityId?: string;
  payload: T;
}

export function buildCommand<T>(
  options: CommandBuilderOptions<T>,
): Command<T> {
  const user = useAuthStore.getState().user;
  const userId = user?.id ?? "anonymous";
  const deviceId = getAppInstanceId();
  const timestamp = new Date().toISOString();

  // Inject inserted_at / updated_at into payload so the backend preserves the
  // original client creation time for offline-first sync.
  const payload = {
    ...(options.payload as Record<string, unknown>),
    inserted_at: timestamp,
    updated_at: timestamp,
  } as T;

  return {
    command_id: generateCommandId(),
    command_type: options.commandType,
    command_version: options.commandVersion ?? "1.0",
    business_id: options.businessId,
    entity_id: options.entityId,
    user_id: userId,
    device_id: deviceId,
    timestamp,
    payload,
  };
}

export { getAppInstanceId };
