export type GdcConnectionState =
  | "idle"
  | "connecting"
  | "connected"
  | "disconnecting"
  | "disconnected"
  | "reconnecting"
  | "error";
