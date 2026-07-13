export type SavedCookie = {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
};

export type KdmItem = Record<string, any>;

export class KdmApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KdmApiError";
  }
}

export class LoginPageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoginPageError";
  }
}
