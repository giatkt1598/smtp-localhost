import { spawn, spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const isWindows = process.platform === 'win32';
const serverDir = dirname(fileURLToPath(new URL('..', import.meta.url)));

function run(command, args) {
  const child = spawn(command, args, {
    stdio: 'inherit',
    shell: isWindows
  });

  child.on('exit', (code, signal) => {
    if (signal || code) {
      process.exitCode = code ?? 1;
    }
  });

  return child;
}

const initialBuild = spawnSync('npm', ['run', 'build'], {
  cwd: serverDir,
  stdio: 'inherit',
  shell: isWindows
});

if (initialBuild.status !== 0) {
  process.exit(initialBuild.status ?? 1);
}

run('npm', ['run', 'build', '--', '--watch']);
run('node', ['--watch', 'dist/index.js']);
