// Account administration for institution sign-in. There are no default accounts; an operator creates each one.
//   npm run user -- add --username nitm.reviewer --name "NITM Reviewer" --role reviewer --institution NITM
//   npm run user -- add --username regulator.one --name "Regulator" --role reviewer            (no --institution: all institutions)
//   npm run user -- disable --username nitm.reviewer
//   npm run user -- set-password --username nitm.reviewer
//   npm run user -- list
// The password is read from EDUTRACE_NEW_PASSWORD or, if that is unset, from the first line of standard input.
// It is never accepted as a command-line argument. Accounts go to the app_users table when EDUTRACE_STORE=postgres
// (EDUTRACE_DATABASE_URL), otherwise to EDUTRACE_USERS_PATH (default data/users.json).
const path = require('node:path');
const { hashPassword, fileDirectory, postgresDirectory } = require('../src/accounts');

const [command] = process.argv.slice(2);
const arg = name => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : null; };
// Stops at the first line, so a password typed at the terminal needs only Enter.
const readStdinLine = () => new Promise(resolve => {
  let data = ''; const done = () => { process.stdin.pause(); resolve(data.split(/\r?\n/)[0]); };
  if (process.stdin.isTTY) process.stderr.write('Password (at least 12 characters): ');
  process.stdin.setEncoding('utf8'); process.stdin.on('data', c => { data += c; if (/\r?\n/.test(data)) done(); }); process.stdin.on('end', done);
});

(async () => {
  let pool = null;
  const directory = process.env.EDUTRACE_STORE === 'postgres'
    ? postgresDirectory(pool = new (require('pg').Pool)({ connectionString: process.env.EDUTRACE_DATABASE_URL }))
    : fileDirectory(process.env.EDUTRACE_USERS_PATH || path.join(__dirname, '..', 'data', 'users.json'));
  try {
    if (command === 'add') {
      const password = process.env.EDUTRACE_NEW_PASSWORD ?? await readStdinLine();
      await directory.add({ username: String(arg('--username') || '').toLowerCase(), display_name: arg('--name') || '', role: arg('--role') || '', institution_code: arg('--institution') ? arg('--institution').toUpperCase() : null, password_hash: hashPassword(password), disabled: false });
      console.log(`Account ${arg('--username')} created (${directory.kind}).`);
    } else if (command === 'disable') {
      await directory.setDisabled(String(arg('--username') || '').toLowerCase(), true);
      console.log(`Account ${arg('--username')} disabled.`);
    } else if (command === 'set-password') {
      const username = String(arg('--username') || '').toLowerCase();
      const password = process.env.EDUTRACE_NEW_PASSWORD ?? await readStdinLine();
      await directory.setPassword(username, hashPassword(password));
      console.log(`Password updated for account ${username} (${directory.kind}).`);
    } else if (command === 'list') {
      console.log(JSON.stringify(await directory.list(), null, 2));
    } else { console.error('Usage: npm run user -- add --username <u> --name <name> --role <role> [--institution <code>] | disable --username <u> | set-password --username <u> | list'); process.exitCode = 2; }
  } catch (error) { console.error(error.message); process.exitCode = 1; } finally { if (pool) await pool.end(); }
})();
