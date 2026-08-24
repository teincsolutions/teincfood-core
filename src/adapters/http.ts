/**
 * HTTP adapter — provides ApiError and a minimal api client interface.
 * Host apps inject a real HTTP client (axios/fetch) via setHttpClient().
 */

export class ApiError extends Error {
  status: number;
  code?: string;
  data?: unknown;

  constructor(message: string, status: number, code?: string, data?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

export interface HttpClient {
  get<T>(url: string, config?: unknown): Promise<{ data: T }>;
  post<T>(url: string, body?: unknown, config?: unknown): Promise<{ data: T }>;
  put<T>(url: string, body?: unknown, config?: unknown): Promise<{ data: T }>;
  patch<T>(url: string, body?: unknown, config?: unknown): Promise<{ data: T }>;
  delete<T>(url: string, config?: unknown): Promise<{ data: T }>;
}

let client: HttpClient | null = null;

export function setHttpClient(c: HttpClient): void {
  client = c;
}

export function getHttpClient(): HttpClient {
  if (!client) {
    throw new Error(
      "HTTP client not injected. Call setHttpClient(client) before making API calls.",
    );
  }
  return client;
}

// Default export compatible with `import { api } from "@/services/api"`
export const api: HttpClient = {
  get: (...args) => getHttpClient().get(...args),
  post: (...args) => getHttpClient().post(...args),
  put: (...args) => getHttpClient().put(...args),
  patch: (...args) => getHttpClient().patch(...args),
  delete: (...args) => getHttpClient().delete(...args),
};
