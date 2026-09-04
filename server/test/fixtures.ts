import { readFileSync } from 'node:fs';
import { xdr } from '@stellar/stellar-sdk';

/** One failure that testnet produced, recorded as the host reported it. */
export interface HostFailure {
  /** The message that the host wrote. */
  readonly error: string;
  /** The diagnostic events, decoded from the recorded base64. */
  readonly events: xdr.DiagnosticEvent[];
}

/** Read a base64 string out of a recorded event list. */
function decodeEvents(value: unknown, name: string): xdr.DiagnosticEvent[] {
  if (!Array.isArray(value)) throw new Error(`${name} carries no event list`);
  return value.map((entry) => {
    if (typeof entry !== 'string') throw new Error(`${name} carries an event that is not base64`);
    return xdr.DiagnosticEvent.fromXDR(entry, 'base64');
  });
}

/**
 * Read the recorded failures.
 *
 * Every fixture is a real failure that testnet produced. The tests guard the
 * decode path and the classifier. A protocol release that rewords a message
 * therefore cannot turn a known failure into `UNKNOWN` in silence.
 */
export function readHostFailures(): Record<string, HostFailure> {
  const path = new URL('../../test/fixtures/host-errors.json', import.meta.url);
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('the fixture file is not a JSON object');
  }
  const failures: Record<string, HostFailure> = {};
  for (const [name, value] of Object.entries({ ...parsed })) {
    if (value === null || typeof value !== 'object') {
      throw new Error(`the fixture ${name} is not an object`);
    }
    const fields: Record<string, unknown> = { ...value };
    const error = fields['error'];
    if (typeof error !== 'string') throw new Error(`the fixture ${name} carries no message`);
    failures[name] = { error, events: decodeEvents(fields['events'], name) };
  }
  return failures;
}
