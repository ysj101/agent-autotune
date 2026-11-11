import { Command } from 'commander';
import { VERSION } from './version.js';

function notImplemented(name: string): () => void {
  return () => {
    process.stderr.write(`agent-autotune ${name}: not implemented yet\n`);
    process.exitCode = 1;
  };
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('agent-autotune')
    .description('Learn project-specific tool failures from Claude Code and offer verified hints.')
    .version(VERSION);

  program
    .command('init')
    .description('register daemon, OTel and Hooks safely')
    .option('--dry-run', 'show what would change without changing anything')
    .option('-y, --yes', 'apply without asking for confirmation')
    .option('--port <port>', 'preferred receiver port', (v) => Number.parseInt(v, 10))
    .option('--no-launchd', 'do not register the launchd agent')
    .action(async (opts: { dryRun?: boolean; yes?: boolean; port?: number; launchd: boolean }) => {
      process.exitCode = await (await import('./commands/init.js')).runInit(opts);
    });
  program
    .command('doctor')
    .description('diagnose versions, port, Hooks, OTel and DB')
    .action(async () => {
      process.exitCode = await (await import('./commands/doctor.js')).runDoctor();
    });
  program
    .command('status')
    .description('show state, observations, active hints and effect')
    .action(async () => {
      process.exitCode = await (await import('./commands/status.js')).runStatus();
    });
  program
    .command('rules')
    .description('list hints with evidence and state')
    .option('--state <state>', 'only hints in this state (candidate, verified, active, stale, disabled, reverted)')
    .option('--json', 'machine-readable output')
    .action(async (opts: { state?: string; json?: boolean }) => {
      process.exitCode = await (await import('./commands/rules.js')).runRules(opts);
    });
  program
    .command('disable')
    .description('stop injection and recording (settings are kept)')
    .option('--rule <id>', 'disable only this hint (id or unique prefix, see `rules`)')
    .action(async (opts: { rule?: string }) => {
      const toggle = await import('./commands/toggle.js');
      process.exitCode = opts.rule ? toggle.runDisableRule(opts.rule) : toggle.runSetEnabled(false);
    });
  program
    .command('enable')
    .description('resume injection and recording')
    .action(async () => {
      process.exitCode = (await import('./commands/toggle.js')).runSetEnabled(true);
    });
  program.command('purge').description('delete locally stored data').action(notImplemented('purge'));
  program
    .command('uninstall')
    .description('remove only what AutoTune added (settings entries and the launchd agent)')
    .option('--dry-run', 'show what would be removed')
    .option('-y, --yes', 'remove without asking for confirmation')
    .action(async (opts: { dryRun?: boolean; yes?: boolean }) => {
      process.exitCode = await (await import('./commands/uninstall.js')).runUninstall(opts);
    });
  program
    .command('daemon')
    .description('internal: run the local receiver (started by launchd)')
    .action(async () => (await import('./commands/daemon.js')).runDaemon());
  program
    .command('hook')
    .description('internal: Claude Code hook entry point (reads JSON from stdin)')
    .argument('<event>', 'hook event name')
    .action(async (event: string) => (await import('./hooks/handler.js')).runHook(event));

  return program;
}

export async function main(argv: string[]): Promise<void> {
  await buildProgram().parseAsync(argv);
}
