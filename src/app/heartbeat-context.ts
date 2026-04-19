import { randomUUID } from "node:crypto";

let currentHeartbeatId: string | null = null;

export function startHeartbeatSession(): string {
  process.env.THREADOS_INTERNAL = "1";
  currentHeartbeatId = randomUUID();
  return currentHeartbeatId;
}

export function getCurrentHeartbeatId(): string | null {
  return currentHeartbeatId;
}
