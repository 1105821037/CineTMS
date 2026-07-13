import type { FinixxConfig } from "./setup-store";
import { ApiError, readOptionalString } from "./http";

export interface ResolvedFinixxConfig {
  readonly baseUrl: string;
  readonly serviceUsername: string;
  readonly servicePassword: string;
  readonly serviceApiKey: string;
  readonly cinemaInfo?: unknown;
}

export function resolveFinixxConfig(
  input: Record<string, unknown>,
  current?: FinixxConfig | null,
): ResolvedFinixxConfig {
  const baseUrl = readOptionalString(input, "baseUrl") ?? current?.baseUrl;
  const serviceUsername = readOptionalString(input, "serviceUsername") ?? current?.serviceUsername;
  const servicePassword = readOptionalString(input, "servicePassword") ?? current?.servicePassword;
  const serviceApiKey = readOptionalString(input, "serviceApiKey") ?? current?.serviceApiKey;

  if (!baseUrl) throw new ApiError(400, "请填写售票系统地址。");
  if (!serviceUsername) throw new ApiError(400, "请填写售票系统服务用户名。");
  if (!servicePassword) throw new ApiError(400, "请填写售票系统服务密码。");
  if (!serviceApiKey) throw new ApiError(400, "请填写售票系统 API Key。");

  return {
    baseUrl,
    serviceUsername,
    servicePassword,
    serviceApiKey,
    cinemaInfo: input.cinemaInfo ?? current?.cinemaInfo,
  };
}

export function requireStoredFinixxConfig(config: FinixxConfig | null): ResolvedFinixxConfig {
  return resolveFinixxConfig({}, config);
}

export function sanitizeFinixxConfig(config: FinixxConfig | null): Record<string, unknown> | null {
  if (!config) return null;
  return {
    baseUrl: config.baseUrl,
    serviceUsername: config.serviceUsername ?? "",
    hasPassword: Boolean(config.servicePassword),
    hasApiKey: Boolean(config.serviceApiKey),
    cinemaInfo: config.cinemaInfo,
  };
}
