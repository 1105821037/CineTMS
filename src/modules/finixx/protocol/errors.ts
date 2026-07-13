export class FinixxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FinixxError";
  }
}

export class FinixxHttpError extends FinixxError {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly rawResponse: string,
  ) {
    super(message);
    this.name = "FinixxHttpError";
  }
}

export class FinixxApiError extends FinixxError {
  constructor(
    message: string,
    readonly result: number | null | undefined,
    readonly rawResponse: string,
    readonly responseBody?: unknown,
    readonly resultDescription?: string,
  ) {
    super(message);
    this.name = "FinixxApiError";
  }
}

export class FinixxResponseParseError extends FinixxError {
  constructor(
    message: string,
    readonly rawResponse: string,
  ) {
    super(message);
    this.name = "FinixxResponseParseError";
  }
}
