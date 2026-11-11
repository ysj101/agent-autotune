#!/usr/bin/env node
// Entry point. `hook` runs on every Claude Code tool call, so it bypasses the CLI framework and
// loads only what it needs; everything else goes through commander.
if (process.argv[2] === 'hook') {
  const { runHook } = await import('./hooks/handler.js');
  await runHook(process.argv[3] ?? '');
} else {
  const { main } = await import('./program.js');
  await main(process.argv);
}
