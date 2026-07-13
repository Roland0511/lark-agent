export class AppError extends Error {
  constructor(
    message: string,
    readonly statusCode = 500,
    readonly code = "internal_error"
  ) {
    super(message);
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
