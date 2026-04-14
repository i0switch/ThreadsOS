import { randomUUID } from "node:crypto";

let currentHeartbeatId: string | null = null;

export function startHeartbeatSession(): string {
  currentHeartbeatId = randomUUID();
  return currentHeartbeatId;
}

export function getCurrentHeartbeatId(): string | null {
  return currentHeartbeatId;
}
