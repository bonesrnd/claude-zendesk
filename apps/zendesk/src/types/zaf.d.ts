export interface ZafRequestOptions {
  url: string;
  type?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  data?: string;
  contentType?: string;
  dataType?: string;
  secure?: boolean;
  cors?: boolean;
  timeout?: number;
  autoRetry?: boolean;
}

export interface ZafMetadata {
  settings: Record<string, unknown>;
}

export interface ZafClient {
  get(paths: string | string[]): Promise<Record<string, unknown>>;
  metadata(): Promise<ZafMetadata>;
  request<T = unknown>(options: ZafRequestOptions): Promise<T>;
  invoke(name: string, ...args: unknown[]): Promise<unknown>;
  on(event: string, callback: () => void): void;
}

declare global {
  const ZAFClient: {
    init(): ZafClient;
  };
}
