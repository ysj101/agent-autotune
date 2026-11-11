#!/usr/bin/env node
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

  program.command('init').description('register daemon, OTel and Hooks safely').action(notImplemented('init'));
  program.command('doctor').description('diagnose versions, port, Hooks, OTel and DB').action(notImplemented('doctor'));
  program.command('status').description('show state, observations, active hints and effect').action(notImplemented('status'));
  program.command('rules').description('list hints with evidence and state').action(notImplemented('rules'));
  program.command('disable').description('stop injection and recording (settings are kept)').action(notImplemented('disable'));
  program.command('enable').description('resume injection and recording').action(notImplemented('enable'));
  program.command('purge').description('delete locally stored data').action(notImplemented('purge'));
  program.command('uninstall').description('remove only what AutoTune added').action(notImplemented('uninstall'));
  program
    .command('daemon')
    .description('internal: run the local receiver (started by launchd)')
    .action(async () => (await import('./commands/daemon.js')).runDaemon());
  program
    .command('hook')
    .description('internal: Claude Code hook entry point (reads JSON from stdin)')
    .argument('<event>', 'hook event name')
    .action(() => {
      // Hooks must never block Claude Code: always exit 0 with empty output.
      process.exitCode = 0;
    });

  return program;
}

export async function main(argv: string[]): Promise<void> {
  await buildProgram().parseAsync(argv);
}

await main(process.argv);
