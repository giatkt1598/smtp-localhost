import { spawn } from 'node:child_process';

const isWindows = process.platform === 'win32';
const children = [];

function run(command, args, cwd) {
  const child = spawn(command, args, {
    cwd,
    stdio: 'inherit',
    shell: isWindows
  });

  children.push(child);

  child.on('exit', (code, signal) => {
    if (signal || code) {
      process.exitCode = code ?? 1;
      for (const other of children) {
        if (other !== child && !other.killed) {
          other.kill();
        }
      }
    }
  });

  return child;
}

run('npm', ['--prefix', 'server', 'run', 'dev'], '.');
run('npm', ['--prefix', 'client', 'run', 'dev'], '.');
