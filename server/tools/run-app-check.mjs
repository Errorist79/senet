// Drive the application check, and say what it produces.
//
// The reproducibility check runs this file with `--list`, from the export.
// This file therefore imports nothing of ours. A value that comes from a
// workspace resolves through the installed link, and that link points at
// somebody's working tree rather than at the export. An import here would
// answer for whatever sits on a desk today.
//
// That is the third thing the rule catches. A listing must answer from the
// export alone: no environment file, no build, and no workspace.
//
// The two rows take their names from the run. One names the voucher that the
// run mints, and the other names the transaction that deploys the account.
// Neither name exists first. This answer therefore prints nothing and
// succeeds, and the rows carry `producer: 'browser'`. The check exempts those,
// because no script signs a passkey or reads a screen.
import { spawnSync } from 'node:child_process';

if (process.argv.includes('--list')) process.exit(0);

const run = (command, args) =>
  spawnSync(command, args, { stdio: 'inherit', env: process.env });

const built = run('npm', ['run', 'build', '--workspace', '@senet/server']);
if (built.status !== 0) process.exit(built.status ?? 1);

const checked = run('node', ['server/dist/tools/app-check.js', ...process.argv.slice(2)]);
process.exit(checked.status ?? 1);
