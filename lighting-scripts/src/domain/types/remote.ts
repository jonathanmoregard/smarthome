import type { Ranged } from './range.ts';

/**
 * A bound of a remote's step range: -20..20, the captured default
 * `{'min':-20,'max':20}`, which is also the widest range the scripts accept
 * (`-20 <= min <= max <= 20`). Not necessarily whole: the check admits any
 * finite number between the ends.
 */
export type Step = Ranged<'Step'>;

/** A command a remote's press acts on. */
export type RemoteCommand = 'up' | 'down' | 'left' | 'right' | 'toggle' | 'reset' | 'sara_toggle';
/** Every {@link RemoteCommand}, for the parser that reads a press. */
export const REMOTE_COMMANDS: readonly RemoteCommand[] = ['up', 'down', 'left', 'right', 'toggle', 'reset', 'sara_toggle'];

/**
 * A press as a remote sends it: a command it acts on, or any other text, which
 * does nothing (the scripts' noop). The other text is never read; it is kept
 * only so a forwarded press names the bytes the remote sent.
 */
export type RemotePress = { kind: 'command'; command: RemoteCommand } | { kind: 'unknown'; text: string };

/** The press as the text it was sent as. */
export function pressText(press: RemotePress): string {
  return press.kind === 'command' ? press.command : press.text;
}

/** The command a press acts on; none for a press that does nothing. */
export function pressCommand(press: RemotePress): RemoteCommand | undefined {
  return press.kind === 'command' ? press.command : undefined;
}
