/** The types of `item-order.mjs`'s exports, for the tests that import it (`tsconfig.test.json`). */

/** One scope's verdict: its name, what breaks rules 1 to 4, and the rule 5 breaches only a person can fix. */
export interface Scope { name: string; found: string[]; manual: string[] }

export function ownership(name: string, text: string): Record<string, string | undefined>;
export function scan(name: string, text: string): Scope[];
export function fixSource(name: string, text: string): { text: string; problems: string[] };
