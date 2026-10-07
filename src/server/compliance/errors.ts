/** A refusal from the compliance store, carried to the HTTP status it means. */
export class ComplianceError extends Error {
  constructor(
    message: string,
    public readonly status = 400
  ) {
    super(message);
    this.name = 'ComplianceError';
  }
}
