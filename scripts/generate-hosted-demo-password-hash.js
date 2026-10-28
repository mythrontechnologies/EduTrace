const { hashPassword } = require('../src/accounts');

function readHidden(prompt) {
  const input = process.stdin;
  if (!input.isTTY || typeof input.setRawMode !== 'function') throw new Error('Run this command in an interactive terminal so the password can be hidden.');
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (error, result) => {
      input.removeListener('data', onData);
      input.setRawMode(false); input.pause();
      process.stdout.write('\n');
      error ? reject(error) : resolve(result);
    };
    const onData = chunk => {
      for (const char of String(chunk)) {
        if (char === '\u0003') return finish(new Error('Cancelled.'));
        if (char === '\r' || char === '\n') return finish(null, value);
        if (char === '\u0008' || char === '\u007f') value = [...value].slice(0, -1).join('');
        else if (value.length < 256 && char >= ' ') value += char;
      }
    };
    process.stdout.write(prompt);
    input.setEncoding('utf8'); input.setRawMode(true); input.resume(); input.on('data', onData);
  });
}

async function main() {
  try {
    const first = await readHidden('New hosted demo password (20–256 characters, hidden): ');
    const second = await readHidden('Confirm hosted demo password (hidden): ');
    if (first.length < 20 || first.length > 256) throw new Error('Use a password between 20 and 256 characters.');
    if (first !== second) throw new Error('The password entries did not match.');
    process.stdout.write(`${hashPassword(first)}\n`);
    process.stdout.write('Copy only the scrypt hash into the hosting secret EDUTRACE_HOSTED_DEMO_PASSWORD_HASH. Do not save the password or hash in the repository.\n');
  } catch (error) {
    process.stderr.write(`Password hash not generated: ${error.message}\n`);
    process.exitCode = 1;
  }
}

main();
