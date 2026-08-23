/**
 * Types for the org-scoping ESLint plugin, so the api test that pins
 * `ORG_SCOPED_TABLES` against the live schema can import it under
 * `noImplicitAny`. The rules themselves are consumed by ESLint, which does not
 * need types, so they are declared loosely on purpose.
 */
export declare const ORG_SCOPED_TABLES: readonly string[];

export declare const orgScope: {
  readonly rules: Readonly<Record<string, unknown>>;
};
