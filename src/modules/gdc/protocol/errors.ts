export class GdcError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class GdcProtocolError extends GdcError {
  constructor(message: string) {
    super(message, "GDC_PROTOCOL_ERROR");
  }
}

export class GdcTimeoutError extends GdcError {
  constructor(message = "GDC request timed out") {
    super(message, "GDC_TIMEOUT");
  }
}

export class GdcConnectionError extends GdcError {
  constructor(message: string) {
    super(message, "GDC_CONNECTION_ERROR");
  }
}

export class GdcResponseError extends GdcError {
  constructor(
    message: string,
    public readonly responseXml: string,
  ) {
    super(message, "GDC_RESPONSE_ERROR");
  }
}
