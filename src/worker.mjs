import { digest, hashPassword, randomToken, sessionCookie, sessionLifetime, sessionToken, verifyPassword } from './security.mjs';
import { demoLogin, refreshDemo, withDemoPhoto } from './demo.mjs';

const sites = ['suga', 'sano'];
const slots = ['10:00〜12:00', '14:00〜16:00'];
const prefectures = '北海道 青森県 岩手県 宮城県 秋田県 山形県 福島県 茨城県 栃木県 群馬県 埼玉県 千葉県 東京都 神奈川県 新潟県 富山県 石川県 福井県 山梨県 長野県 岐阜県 静岡県 愛知県 三重県 滋賀県 京都府 大阪府 兵庫県 奈良県 和歌山県 鳥取県 島根県 岡山県 広島県 山口県 徳島県 香川県 愛媛県 高知県 福岡県 佐賀県 長崎県 熊本県 大分県 宮崎県 鹿児島県 沖縄県'.split(' ');
const seconds = () => Math.floor(Date.now() / 1000);
const today = () => new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
const uuid = () => crypto.randomUUID();
const isUuid = value => typeof value === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(value);
const hasText = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const validLogin = value => typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{2,39}$/.test(value);
const validPassword = value => hasText(value, 128) && value.length >= 12;
const siteList = account => account.staff_site === 'all' ? sites : [account.staff_site];
const rows = async statement => (await statement.all()).results;
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function requireThat(condition, message, status = 400) {
  if (!condition) throw new HttpError(status, message);
}
function result(data, status = 200, extra = {}) {
  return Response.json(data, { status, headers: { ...headers, ...extra } });
}
function empty() { return new Response(null, { status: 204, headers }); }

async function jsonBody(request) {
  requireThat(request.headers.get('Content-Type')?.split(';')[0] === 'application/json', '送信形式を確認してください。', 415);
  const reader = request.body?.getReader();
  requireThat(reader, '入力内容が空です。');
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 460_000) {
      await reader.cancel();
      throw new HttpError(413, '写真または入力内容が大きすぎます。');
    }
    chunks.push(value);
  }
  let data;
  try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, '入力内容を確認してください。'); }
  requireThat(data && typeof data === 'object' && !Array.isArray(data), '入力内容を確認してください。');
  return data;
}

async function accountFor(db, request) {
  const token = sessionToken(request);
  if (!token) return null;
  const hash = await digest(token);
  return db.prepare(`SELECT a.*, s.token_hash AS session_hash, o.site AS member_site
    FROM sessions s JOIN accounts a ON a.login = s.account_login
    LEFT JOIN organizations o ON o.id = a.organization_id
    WHERE s.token_hash = ? AND s.expires_at > ?`).bind(hash, seconds()).first();
}
async function limitAttempts(db, request, bucket, limit, perIp = true) {
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  const key = await digest(perIp ? bucket + ':' + ip : bucket);
  const window = Math.floor(seconds() / 900) * 900;
  const row = await db.prepare(`INSERT INTO login_rate(rate_key, window_start, attempts) VALUES (?, ?, 1)
    ON CONFLICT(rate_key) DO UPDATE SET
    attempts = CASE WHEN window_start = excluded.window_start THEN attempts + 1 ELSE 1 END,
    window_start = excluded.window_start RETURNING attempts`).bind(key, window).first();
  requireThat(row.attempts <= limit, '試行回数が多すぎます。しばらく待ってから再度お試しください。', 429);
  await db.prepare('DELETE FROM login_rate WHERE window_start < ?').bind(window - 900).run();
}
function role(account, expected) {
  requireThat(account.role === expected, 'この操作を行う権限がありません。', 403);
}
function staffSite(account, site) {
  role(account, 'staff');
  requireThat(siteList(account).includes(site), 'この拠点を操作する権限がありません。', 403);
}

async function snapshot(db, account, demo) {
  const staff = account.role === 'staff';
  const permitted = staff ? siteList(account) : [account.member_site];
  const [first, second = first] = permitted;
  const session = {
    login: account.login, role: account.role, organization: account.organization_id,
    sites: permitted.filter(Boolean), manager: staff && account.staff_site === 'all',
    mustChange: Boolean(account.must_change)
  };
  if (session.mustChange) return { session, products: [], bookings: [], profiles: {}, organizations: {} };
  const productsQuery = db.prepare(`SELECT id, site, name, kind, expires, stock, unit,
    CASE WHEN photo <> '' THEN '/api/products/' || id || '/photo' ELSE '' END AS photo
    FROM products WHERE site IN (?, ?) ORDER BY expires, name`).bind(first, second);
  const bookingsQuery = `SELECT b.id, b.organization_id AS organization, b.product_id AS product,
    b.site, p.name, p.unit, b.quantity AS count, b.use_date AS use, b.pickup_date AS pickup, b.slot,
    b.status, b.prepared, b.handed_over_at AS handedOverAt
    FROM bookings b JOIN products p ON p.id = b.product_id`;
  const orgQuery = `SELECT o.*, a.login FROM organizations o JOIN accounts a ON a.organization_id = o.id`;
  const [products, bookings, records] = await Promise.all([
    rows(productsQuery),
    rows(staff
      ? db.prepare(bookingsQuery + ' WHERE b.site IN (?, ?) ORDER BY b.created_at, b.id').bind(first, second)
      : db.prepare(bookingsQuery + ' WHERE b.organization_id = ? ORDER BY b.created_at, b.id').bind(account.organization_id)),
    rows(staff
      ? db.prepare(orgQuery + ` WHERE ? = 'all' OR o.site IN (?, ?) OR EXISTS (
        SELECT 1 FROM bookings b WHERE b.organization_id = o.id AND b.site IN (?, ?)
      ) ORDER BY o.name`).bind(account.staff_site, first, second, first, second)
      : db.prepare(orgQuery + ' WHERE o.id = ?').bind(account.organization_id))
  ]);
  const organizations = Object.fromEntries(records.map(org => [org.id, { name: org.name, login: org.login }]));
  const profiles = Object.fromEntries(records
    .filter(org => org.prefecture && (!staff || session.manager || permitted.includes(org.site)))
    .map(org => [org.id, {
      prefecture: org.prefecture, city: org.city, address: org.address,
      contactName: org.contact_name, postalCode: org.postal_code
    }]));
  return { session, products: demo ? products.map(withDemoPhoto) : products, profiles, organizations,
    bookings: bookings.map(item => ({ ...item, prepared: Boolean(item.prepared) })) };
}
async function startSession(db, account, request, demo = false) {
  const token = randomToken();
  const now = seconds();
  const previous = sessionToken(request);
  const removePrevious = previous ? [db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await digest(previous))] : [];
  await db.batch([
    ...removePrevious,
    db.prepare('DELETE FROM sessions WHERE account_login = ? AND expires_at <= ?').bind(account.login, now),
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').bind(await digest(token), account.login, now + sessionLifetime)
  ]);
  return result(await snapshot(db, account, demo), 200, { 'Set-Cookie': sessionCookie(token, sessionLifetime) });
}

async function login(db, request, demo) {
  const body = await jsonBody(request);
  const id = typeof body.login === 'string' ? body.login.trim().toLowerCase() : '';
  requireThat(validLogin(id) && hasText(body.password, 128), 'IDまたはパスワードを確認してください。', 401);
  await limitAttempts(db, request, 'login', 18);
  if (!demo) await limitAttempts(db, request, 'login-account:' + id, 18, false);
  const account = await db.prepare(`SELECT a.*, o.site AS member_site FROM accounts a
    LEFT JOIN organizations o ON o.id = a.organization_id WHERE a.login = ?`).bind(id).first();
  const valid = await verifyPassword(body.password, account?.password_hash);
  requireThat(valid && account, 'IDまたはパスワードを確認してください。', 401);
  return startSession(db, account, request, demo);
}
async function setup(db, request) {
  const body = await jsonBody(request);
  requireThat(validLogin(body.login) && validPassword(body.password), 'IDは半角英数字など3文字以上、パスワードは12文字以上で入力してください。');
  requireThat(typeof body.token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(body.token), '初期設定リンクを確認してください。', 403);
  await limitAttempts(db, request, 'setup', 8);
  const tokenHash = await digest(body.token);
  const now = seconds();
  const code = await db.prepare('SELECT 1 FROM setup_codes WHERE token_hash = ? AND expires_at > ?').bind(tokenHash, now).first();
  requireThat(code, '初期設定リンクが無効か、有効期限を過ぎています。', 403);
  const passwordHash = await hashPassword(body.password);
  const [created] = await db.batch([
    db.prepare(`INSERT INTO accounts(login, password_hash, role, staff_site)
      SELECT ?, ?, 'staff', 'all' FROM setup_codes WHERE token_hash = ? AND expires_at > ?
      AND NOT EXISTS (SELECT 1 FROM accounts WHERE role = 'staff')`).bind(body.login, passwordHash, tokenHash, now),
    db.prepare(`DELETE FROM setup_codes WHERE EXISTS (SELECT 1 FROM accounts WHERE role = 'staff')`)
  ]);
  requireThat(created.meta.changes === 1, '初期設定はすでに完了しています。', 409);
  return startSession(db, { login: body.login, role: 'staff', staff_site: 'all', organization_id: null }, request);
}
async function changePassword(db, request, account, body) {
  requireThat(validPassword(body.password) && hasText(body.current, 128), '新しいパスワードを12文字以上で入力してください。');
  requireThat(body.current !== body.password, '現在のパスワードとは異なるものを入力してください。');
  await limitAttempts(db, request, 'password:' + account.login, 8);
  requireThat(await verifyPassword(body.current, account.password_hash), '現在のパスワードが正しくありません。', 403);
  const passwordHash = await hashPassword(body.password);
  const [changed] = await db.batch([
    db.prepare('UPDATE accounts SET password_hash = ?, must_change = 0 WHERE login = ? AND password_hash = ?')
      .bind(passwordHash, account.login, account.password_hash),
    db.prepare(`DELETE FROM sessions WHERE account_login = ? AND token_hash <> ?
      AND EXISTS (SELECT 1 FROM accounts WHERE login = ? AND password_hash = ?)`)
      .bind(account.login, account.session_hash, account.login, passwordHash)
  ]);
  requireThat(changed.meta.changes === 1, '現在のパスワードを確認してください。', 409);
  return empty();
}

async function createAccount(db, account, body) {
  role(account, 'staff');
  requireThat(account.staff_site === 'all', 'アカウントを発行する権限がありません。', 403);
  const { login, password } = body;
  requireThat(validLogin(login) && validPassword(password), 'IDは半角の英数字など3文字以上、仮パスワードは12文字以上で入力してください。');
  requireThat(['member', 'staff'].includes(body.role), 'アカウントの種類を選んでください。');
  const existing = await db.prepare('SELECT 1 FROM accounts WHERE login = ?').bind(login).first();
  requireThat(!existing, 'このIDはすでに使われています。', 409);
  const passwordHash = await hashPassword(password);
  try {
    if (body.role === 'member') {
      requireThat(hasText(body.name, 70), '団体名を入力してください。');
      const organization = uuid();
      await db.batch([
        db.prepare('INSERT INTO organizations(id, name) VALUES (?, ?)').bind(organization, body.name.trim()),
        db.prepare(`INSERT INTO accounts(login, password_hash, role, organization_id, must_change)
          VALUES (?, ?, 'member', ?, 1)`).bind(login, passwordHash, organization)
      ]);
    } else {
      requireThat(sites.includes(body.site), 'スタッフの担当拠点を選んでください。');
      await db.prepare(`INSERT INTO accounts(login, password_hash, role, staff_site, must_change)
        VALUES (?, ?, 'staff', ?, 1)`).bind(login, passwordHash, body.site).run();
    }
  } catch (error) {
    if (String(error.message).includes('accounts.login')) throw new HttpError(409, 'このIDはすでに使われています。');
    throw error;
  }
  return empty();
}
async function updateProfile(db, account, body) {
  role(account, 'member');
  const { prefecture, city, address, contactName, postalCode = '' } = body;
  requireThat(prefectures.includes(prefecture) && hasText(city, 70) && hasText(address, 120) &&
    hasText(contactName, 70) && typeof postalCode === 'string' && /^(?:\d{7})?$/.test(postalCode), '住所と担当者名を確認してください。');
  await db.prepare('UPDATE organizations SET prefecture = ?, city = ?, address = ?, contact_name = ?, postal_code = ? WHERE id = ?')
    .bind(prefecture, city.trim(), address.trim(), contactName.trim(), postalCode, account.organization_id).run();
  return empty();
}
function dateIsValid(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const time = Date.parse(date);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === date;
}
async function registerProduct(db, account, body) {
  staffSite(account, body.site);
  const { name, kind, expires, stock, unit, photo = '' } = body;
  requireThat(hasText(name, 40) && hasText(unit, 10) && ['賞味期限', '消費期限'].includes(kind) &&
    dateIsValid(expires) && expires >= today() && Number.isInteger(stock) && stock > 0 && stock <= 9999,
    '食品名、数量、単位、期限を確認してください。');
  requireThat(typeof photo === 'string' && photo.length <= 400_000 && (photo === '' ||
    /^data:image\/jpeg;base64,\/9j\/[A-Za-z0-9+/]*={0,2}$/.test(photo)), '写真のサイズまたは形式を確認してください。');
  await db.prepare('INSERT INTO products VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(uuid(), body.site, name.trim(), kind, expires, stock, unit.trim(), photo).run();
  return empty();
}
async function foodPhoto(db, account, id) {
  const photo = await db.prepare("SELECT site, photo FROM products WHERE id = ? AND photo <> ''").bind(id).first();
  requireThat(photo && (account.role === 'staff' ? siteList(account).includes(photo.site) : account.member_site === photo.site),
    '写真が見つかりません。', 404);
  return new Response(Buffer.from(photo.photo.split(',')[1], 'base64'), {
    headers: { ...headers, 'Content-Type': 'image/jpeg' }
  });
}
async function book(db, account, body) {
  role(account, 'member');
  requireThat(account.member_site, '受取拠点を確認してください。', 409);
  const { requestId, use, slot, items } = body;
  requireThat(isUuid(requestId) && dateIsValid(use) && use >= today() && slots.includes(slot) &&
    Array.isArray(items) && items.length >= 1 && items.length <= 40 &&
    items.every(item => item && isUuid(item.product) && Number.isInteger(item.count) && item.count > 0 && item.count <= 9999) &&
    new Set(items.map(item => item.product)).size === items.length, '予約内容を確認してください。');
  const fingerprint = await digest(JSON.stringify([use, slot, items.map(item => [item.product, item.count]).sort()]));
  try {
    await db.batch([
      db.prepare('INSERT INTO booking_batches VALUES (?, ?, ?)').bind(requestId, account.organization_id, fingerprint),
      ...items.map(({ product, count }) => db.prepare(`INSERT INTO bookings
        (id, batch_id, organization_id, product_id, site, quantity, use_date, pickup_date, slot, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(uuid(), requestId, account.organization_id, product, account.member_site, count, use, use, slot, seconds()))
    ]);
  } catch (error) {
    const old = await db.prepare('SELECT organization_id, fingerprint FROM booking_batches WHERE id = ?').bind(requestId).first();
    if (old?.organization_id === account.organization_id && old.fingerprint === fingerprint) return empty();
    if (/stock_unavailable|booking_batches.id/.test(String(error.message))) {
      throw new HttpError(409, '在庫または受取拠点が変更されました。内容を確認してください。');
    }
    throw error;
  }
  return empty();
}
async function cancel(db, account, id) {
  role(account, 'member');
  const cancelled = await db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ? AND organization_id = ? AND status = 'pending' RETURNING id")
    .bind(id, account.organization_id).first();
  requireThat(cancelled, 'この予約はキャンセルできません。', 409);
  return empty();
}
function validateHandoff(account, body) {
  staffSite(account, body.site);
  requireThat(isUuid(body.organization) && dateIsValid(body.pickup) && slots.includes(body.slot), '受取日時を確認してください。');
  return [body.site, body.organization, body.pickup, body.slot];
}
const appointmentWhere = "site = ? AND organization_id = ? AND pickup_date = ? AND slot = ? AND status = 'pending'";
async function prepare(db, account, body) {
  const group = validateHandoff(account, body);
  requireThat(typeof body.checked === 'boolean' && Array.isArray(body.ids) &&
    body.ids.length > 0 && body.ids.length <= 250 && body.ids.every(isUuid), '準備する商品を確認してください。');
  const r = await db.prepare(`UPDATE bookings SET prepared = ? WHERE ${appointmentWhere}
    AND id IN (SELECT value FROM json_each(?))`).bind(Number(body.checked), ...group, JSON.stringify(body.ids)).run();
  requireThat(r.meta.changes > 0, '予約の状態が更新されました。内容を確認してください。', 409);
  return empty();
}
async function handoff(db, account, body) {
  const group = validateHandoff(account, body);
  const r = await db.prepare(`UPDATE bookings SET status = 'done', handed_over_at = ?
    WHERE ${appointmentWhere} AND NOT EXISTS
    (SELECT 1 FROM bookings WHERE ${appointmentWhere} AND prepared = 0)`)
    .bind(new Date().toISOString(), ...group, ...group).run();
  requireThat(r.meta.changes > 0, 'すべての商品を準備してから引き渡しを確定してください。', 409);
  return empty();
}

async function api(request, env, url) {
  const demo = Boolean(env.DEMO_DB);
  if (demo && env.DB) throw new Error('Demo and production databases must be bound to separate Workers');
  const db = demo ? env.DEMO_DB : env.DB;
  const route = request.method + ' ' + url.pathname;
  if (request.method !== 'GET') {
    requireThat(request.headers.get('Origin') === url.origin, 'ページを開き直してください。', 403);
  }
  if (demo) {
    requireThat(!['POST /api/setup', 'PUT /api/password', 'POST /api/accounts'].includes(route),
      'デモでは、共通の試作用アカウントをご利用ください。', 403);
    if (route === 'GET /api/state' || route === 'POST /api/login') await refreshDemo(db, today());
  }
  if (route === 'POST /api/login') return login(db, request, demo);
  if (route === 'POST /api/setup') return setup(db, request);
  const account = await accountFor(db, request);
  if (route === 'GET /api/state') {
    const data = account ? await snapshot(db, account, demo) : { session: null };
    return result(demo ? { ...data, demo: demoLogin } : data);
  }
  if (route === 'POST /api/logout') {
    if (account) await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(account.session_hash).run();
    return result({ session: null }, 200, { 'Set-Cookie': sessionCookie() });
  }
  requireThat(account, 'ログインしてください。', 401);
  if (route === 'PUT /api/password') return changePassword(db, request, account, await jsonBody(request));
  requireThat(!account.must_change, '初回のパスワード変更を完了してください。', 403);
  if (demo && route === 'POST /api/demo/reset') {
    role(account, 'staff');
    await refreshDemo(env.DEMO_DB, today(), { reset: true });
    return empty();
  }
  const photoId = request.method === 'GET' && url.pathname.match(/^\/api\/products\/([0-9a-f-]+)\/photo$/)?.[1];
  if (isUuid(photoId)) return foodPhoto(db, account, photoId);
  const cancelId = request.method === 'POST' && url.pathname.match(/^\/api\/bookings\/([0-9a-f-]+)\/cancel$/)?.[1];
  if (isUuid(cancelId)) return cancel(db, account, cancelId);
  const handlers = {
    'PUT /api/profile': updateProfile, 'POST /api/accounts': createAccount, 'POST /api/products': registerProduct,
    'POST /api/bookings': book, 'POST /api/preparation': prepare, 'POST /api/handoff': handoff
  };
  requireThat(handlers[route], 'ページが見つかりません。', 404);
  return handlers[route](db, account, await jsonBody(request));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/api' && !url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try { return await api(request, env, url); }
    catch (error) {
      if (error instanceof HttpError) return result({ error: error.message }, error.status);
      console.error('API request failed', request.method, url.pathname, error.name);
      return result({ error: '処理に失敗しました。時間をおいてもう一度お試しください。' }, 500);
    }
  }
};
