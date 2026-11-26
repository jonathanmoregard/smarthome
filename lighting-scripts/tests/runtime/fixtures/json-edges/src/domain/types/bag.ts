// A domain type under src/domain/types that is still JSON: the guard must read this directory too.
import type { JsonValue } from '../../runtime/context.ts';

export type Bag = { value: JsonValue };
