// Kept in its own module so the CLI can reference the error type without
// importing the ink-based onboarding UI, which is expensive to load.
export class CredentialSetupCancelledError extends Error {
  constructor() {
    super("credential setup cancelled");
    this.name = "CredentialSetupCancelledError";
  }
}
