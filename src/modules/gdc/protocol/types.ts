export interface GdcRequestFrame {
  readonly xml: string;
  readonly payload: Buffer;
}

export interface GdcResponseFrame {
  readonly xml: string;
  readonly raw: Buffer;
}

export interface GdcXmlResponse {
  readonly status: "OK" | "ERROR" | "UNKNOWN";
  readonly version?: string;
  readonly rawXml: string;
}
