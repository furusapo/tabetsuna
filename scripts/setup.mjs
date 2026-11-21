import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { digest, randomToken } from '../src/security.mjs';

const [mode, inputUrl] = process.argv.slice(2);
if (!['--local', '--remote'].includes(mode)) {
  console.error('使い方: npm run setup -- --local または npm run setup -- --remote https://公開URL');
  process.exit(1);
}
const url = new URL(inputUrl || (mode === '--local' ? 'http://127.0.0.1:8787' : ''));
if (url.username || url.password || (mode === '--remote' && url.protocol !== 'https:')) {
  throw new Error('公開URLはHTTPSで指定してください。');
}
const token = randomToken();
const hash = await digest(token);
const expiresAt = Math.floor(Date.now() / 1000) + 1800;
const sql = `INSERT INTO setup_codes (token_hash, expires_at)
  SELECT '${hash}', ${expiresAt} WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE role = 'staff')
  RETURNING expires_at`;
const wrangler = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
const response = spawnSync(process.execPath, [wrangler, 'd1', 'execute', 'tabetsuna', mode, '--json', '--command', sql], { encoding: 'utf8' });
if (response.status !== 0) {
  process.stderr.write(response.stderr || '初期設定リンクの発行に失敗しました。\n');
  process.exit(1);
}
const [mutation] = JSON.parse(response.stdout);
if (mutation?.results?.length !== 1) {
  console.error('管理者はすでに登録されています。');
  process.exit(1);
}
url.hash = new URLSearchParams({setup:token}).toString();
console.log(url.href);
