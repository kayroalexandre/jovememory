import { hashPassword } from '../src/gateway-oauth.mjs';
import { safeError } from '../src/config.mjs';

// The password itself is never stored, printed or accepted as an argument; only its scrypt hash
// becomes a private gateway variable.
try {
  const chunks = [];
  let size = 0;
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 1024) throw Object.assign(new Error('The password is longer than the accepted length.'), { code: 'INPUT' });
    chunks.push(chunk);
  }
  const password = chunks.join('').replace(/\r?\n$/, '');
  if (!password) throw Object.assign(new Error('Provide the operator password on stdin.'), { code: 'INPUT' });
  process.stdout.write(`${await hashPassword(password)}\n`);
} catch (error) {
  console.error(JSON.stringify(safeError(error)));
  process.exitCode = 1;
}
