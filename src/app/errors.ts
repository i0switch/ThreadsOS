export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 500,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id: string) {
    super(`${resource} not found: ${id}`, "NOT_FOUND", 404);
    this.name = "NotFoundError";
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(message, "VALIDATION_ERROR", 400);
    this.name = "ValidationError";
  }
}

export class ExternalApiError extends AppError {
  constructor(service: string, message: string) {
    super(`${service}: ${message}`, "EXTERNAL_API_ERROR", 502);
    this.name = "ExternalApiError";
  }
}

export class AuditFailedError extends AppError {
  constructor(itemType: string, reason: string) {
    super(`Audit failed for ${itemType}: ${reason}`, "AUDIT_FAILED", 422);
    this.name = "AuditFailedError";
  }
}
