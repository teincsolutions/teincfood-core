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

  return {
    command_id: generateCommandId(),
    command_type: options.commandType,
    command_version: options.commandVersion ?? "1.0",
    business_id: options.businessId,
    entity_id: options.entityId,
    user_id: userId,
    device_id: deviceId,
    timestamp: new Date().toISOString(),
    payload: options.payload,
  };
}

export { getAppInstanceId };
