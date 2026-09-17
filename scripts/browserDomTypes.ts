export {};

declare global {
  /** Minimal browser-evaluation shape used by Playwright acceptance under the server-only TS lib set. */
  interface HTMLOptionElement {
    value: string;
  }
}
