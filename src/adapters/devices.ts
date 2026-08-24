/**
 * Devices service stub.
 */

let appInstanceId = "core-device-id";

export function setAppInstanceId(id: string): void {
  appInstanceId = id;
}

export function getAppInstanceId(): string {
  return appInstanceId;
}
