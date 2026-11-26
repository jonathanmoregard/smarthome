import type { JsonObject } from './ha-client.ts';
export const call = (data: JsonObject) => ({ service: 'x', data });
