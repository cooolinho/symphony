/** Error with a stable machine-readable code (see docs/conformance.md for the list). */
export class SymphonyError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SymphonyError';
    this.code = code;
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function errorCode(error: unknown, fallback: string): string {
  return error instanceof SymphonyError ? error.code : fallback;
}
