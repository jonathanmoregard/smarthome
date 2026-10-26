import { createInterface } from 'node:readline';
import { execute, type ExecutionRequest } from './runtime/engine.ts';
import { handlers } from './runtime/registry.ts';

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  try {
    const input: unknown = JSON.parse(line);
    if (!input || typeof input !== 'object' || !('script' in input) || typeof input.script !== 'string'
      || !('snapshot' in input) || !input.snapshot || typeof input.snapshot !== 'object'
      || !('args' in input) || !input.args || typeof input.args !== 'object' || Array.isArray(input.args)) {
      throw new Error('Expected {script, args, snapshot}');
    }
    process.stdout.write(JSON.stringify(execute(input as ExecutionRequest, handlers)) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) + '\n');
  }
}
