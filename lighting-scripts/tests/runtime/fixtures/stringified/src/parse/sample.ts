// The parse layer is in scope: stringifying a JSON value is the shape the guard exists for.
type Json = string | number | boolean | null | { [key: string]: Json } | Json[];

export function instance(key: string, selection: Json): string {
  // One site: `String(selection)`. `key` is text.
  return `${key}:` + String(selection);
}
