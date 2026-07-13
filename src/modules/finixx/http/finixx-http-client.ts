import iconv from "iconv-lite";
import {
  FinixxApiError,
  FinixxHttpError,
  FinixxResponseParseError,
} from "../protocol/errors";
import { resolveFinixxResultMessage } from "../protocol/result-messages";
import type { FinixxResultMessageMap } from "../sdk/types";

export interface FinixxHttpClientOptions {
  readonly baseUrl: string;
  readonly requestTimeoutMs?: number;
  readonly resultMessageMap?: FinixxResultMessageMap;
}

export interface FinixxHttpResponse<T> {
  readonly statusCode: number;
  readonly headers: Headers;
  readonly rawText: string;
  readonly body: T;
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

export class FinixxHttpClient {
  private readonly baseUrl: string;

  constructor(private readonly options: FinixxHttpClientOptions) {
    this.baseUrl = trimTrailingSlash(options.baseUrl);
  }

  async postJson<TResponse>(
    path: string,
    payload: Record<string, unknown>,
  ): Promise<FinixxHttpResponse<TResponse>> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.options.requestTimeoutMs ?? 10_000,
    );

    try {
      const requestBody = iconv.encode(JSON.stringify(payload), "gb2312");
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json; charset=gb2312",
          "accept": "application/json, text/xml, application/xml, text/plain, */*",
        },
        body: requestBody,
        signal: controller.signal,
      });

      const buffer = Buffer.from(await response.arrayBuffer());
      const rawText = iconv.decode(buffer, "gb2312");

      if (!response.ok) {
        throw new FinixxHttpError(
          `Finixx HTTP request failed with status ${response.status}`,
          response.status,
          rawText,
        );
      }

      let body: TResponse;
      try {
        body = JSON.parse(rawText) as TResponse;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new FinixxResponseParseError(
          `Unable to parse Finixx response as JSON: ${message}`,
          rawText,
        );
      }

      if (
        body &&
        typeof body === "object" &&
        "result" in body &&
        typeof (body as { result?: unknown }).result === "number" &&
        (body as { result: number }).result !== 0
      ) {
        const result = (body as { result: number }).result;
        const apiMessage = "message" in body && typeof (body as { message?: unknown }).message === "string"
          ? (body as { message: string }).message
          : undefined;
        const resultDescription = resolveFinixxResultMessage(result, this.options.resultMessageMap);
        const message = resultDescription
          ? `Finixx API returned result ${result}: ${resultDescription}`
          : apiMessage
            ? apiMessage
            : `Finixx API returned result ${result}`;
        throw new FinixxApiError(
          message,
          result,
          rawText,
          body,
          resultDescription,
        );
      }

      return {
        statusCode: response.status,
        headers: response.headers,
        rawText,
        body,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
