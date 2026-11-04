/** User-facing input / validation failure shared by CLI and the local web API. */
export class UserInputError extends Error {
  readonly details: string[];

  constructor(message: string, details: string[] = []) {
    super(message);
    this.name = "UserInputError";
    this.details = details;
  }
}
