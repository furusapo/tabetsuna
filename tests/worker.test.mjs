import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { digest, randomToken } from '../src/security.mjs';

const appUrl = 'https://tabetsuna.test';
const today = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
const firstSlot = '10:00〜12:00';
const tempPassword = 'Test-only-first-password';
const newPassword = 'Test-only-changed-password';
const workerModules = ['worker', 'security', 'demo'].map(name => ({ type: 'ESModule', path: 'src/' + name + '.mjs' }));

test('Worker and D1 share bookings between accounts and enforce roles and stock', async t => {
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: workerModules,
    compatibilityDate: '2026-10-30',
    compatibilityFlags: ['nodejs_compat'], d1Databases: { DB: 'tabetsuna-tests' }
  }));
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('DB');
  const schema = await readFile('migrations/0001_initial.sql', 'utf8');
  await db.batch(schema.trim().split(/;\s+(?=CREATE )/).map(sql => db.prepare(sql)));
  const setupToken = randomToken();
  await db.prepare('INSERT INTO setup_codes VALUES (?, ?)').bind(await digest(setupToken), Math.floor(Date.now() / 1000) + 600).run();

  const request = (path, { method = 'GET', body, cookie, origin = appUrl } = {}) =>
    mf.dispatchFetch(appUrl + '/api/' + path, {
      method,
      headers: { ...(method !== 'GET' && { Origin:origin, 'Content-Type':'application/json' }), ...(cookie && { Cookie:cookie }) },
      ...(body !== undefined && {body:JSON.stringify(body)})
    });
  const send = (path, body, cookie, method = 'POST') => request(path,{method,body,cookie});
  const sessionCookie = response => {
    assert.equal(response.status, 200);
    assert.match(response.headers.get('Set-Cookie'), /Secure; HttpOnly; SameSite=Strict/);
    return response.headers.get('Set-Cookie').split(';')[0];
  };
  const state = async cookie => {
    const response = await request('state',{cookie});
    assert.equal(response.status,200);
    return response.json();
  };
  async function issueAndActivate(account, admin) {
    const creation = await send('accounts',{...account,password:tempPassword},admin);
    assert.equal(creation.status,204,await creation.text());
    const login = await send('login',{login:account.login,password:tempPassword});
    const cookie = sessionCookie(login);
    assert.equal((await login.json()).session.mustChange,true);
    assert.equal((await state(cookie)).bookings.length,0);
    const changed = await send('password',{current:tempPassword,password:newPassword},cookie,'PUT');
    assert.equal(changed.status,204,await changed.text());
    return cookie;
  }

  assert.deepEqual(await state(),{session:null});
  assert.equal((await send('login',{login:'staff',password:'demo2026'})).status,401);
  assert.equal((await request('setup',{method:'POST',origin:'https://other.test',body:{}})).status,403);
  const boot = {token:setupToken,login:'test-admin',password:'Test-only-admin-password'};
  const init = await send('setup',boot);
  const admin = sessionCookie(init);
  assert.equal((await init.json()).session.manager,true);
  assert.equal((await send('setup',boot)).status,403);
  assert.equal((await send('login',{login:'test-admin',password:'wrong'})).status,401);
  const member = await issueAndActivate({role:'member',login:'test-member',name:'検証用子ども食堂'},admin);
  const other = await issueAndActivate({role:'member',login:'test-other',name:'検証用別団体'},admin);
  const staff = await issueAndActivate({role:'staff',site:'suga',login:'test-staff'},admin);
  assert.equal((await send('accounts',{login:'test-forbidden'},staff)).status,403);
  const profile = {prefecture:'栃木県',city:'佐野市',address:'架空町1-2-3',contactName:'検証担当',postalCode:'3270843'};
  assert.equal((await send('profile',profile,member,'PUT')).status,204);
  assert.equal((await send('profile',{...profile,prefecture:'埼玉県',city:'川口市'},other,'PUT')).status,204);
  assert.equal((await send('products',{site:'sano'},staff)).status,403);
  for (const [site,name,stock] of [['sano','食パン',5],['sano','豆腐',1],['suga','米',9]]) {
    const response = await send('products',{site,name,stock,kind:'賞味期限',unit:'袋',expires:today},admin);
    assert.equal(response.status,204,await response.text());
  }
  const memberState = await state(member);
  const bread = memberState.products.find(product => product.name === '食パン').id;
  const tofu = memberState.products.find(product => product.name === '豆腐').id;
  assert.equal(memberState.products.length,2);
  assert.equal((await state(staff)).products.length,1);
  assert.equal(Object.values((await state(staff)).profiles).some(org => org.prefecture === '栃木県'),false);

  const order = (items, requestId = crypto.randomUUID()) => ({requestId,use:today,slot:firstSlot,items});
  const failed = await send('bookings',order([{product:bread,count:2},{product:tofu,count:2}]),member);
  assert.equal(failed.status,409,await failed.text());
  assert.equal((await state(member)).products.find(product => product.id === bread).stock,5);
  const purchase = order([{product:bread,count:2},{product:tofu,count:1}]);
  assert.equal((await send('bookings',purchase,member)).status,204);
  assert.equal((await send('bookings',purchase,member)).status,204);
  const [first,second] = await Promise.all([
    send('bookings',order([{product:bread,count:2}]),member),
    send('bookings',order([{product:bread,count:2}]),member)
  ]);
  assert.deepEqual([first.status,second.status].sort(),[204,409]);
  const adminState = await state(admin);
  assert.equal(adminState.products.find(product => product.id === bread).stock,1);
  assert.equal(adminState.bookings.length,3);
  assert.equal((await state(other)).bookings.length,0);
  assert.equal((await state(staff)).bookings.length,0);
  const breadOrder = adminState.bookings.find(item => item.product === bread);
  assert.equal((await send('bookings/'+breadOrder.id+'/cancel',{},other)).status,409);
  assert.equal((await send('bookings/'+breadOrder.id+'/cancel',{},member)).status,204);
  assert.equal((await send('bookings/'+breadOrder.id+'/cancel',{},member)).status,409);
  assert.equal((await state(admin)).products.find(product => product.id === bread).stock,3);
  const group = {site:'sano',organization:memberState.session.organization,pickup:today,slot:firstSlot};
  assert.equal((await send('handoff',group,admin)).status,409);
  const pending = (await state(admin)).bookings.filter(item => item.status === 'pending');
  assert.equal((await send('preparation',{...group,checked:true,ids:pending.map(item=>item.id)},staff)).status,403);
  assert.equal((await send('preparation',{...group,checked:true,ids:pending.map(item=>item.id)},admin)).status,204);
  assert.equal((await send('handoff',group,admin)).status,204);
  assert.equal((await state(member)).bookings.filter(item => item.status === 'done').length,2);
  assert.equal((await send('logout',{},member)).status,200);
  assert.deepEqual(await state(member),{session:null});
});

test('Demo accounts share sample bookings and stay usable across daily resets', async t => {
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: workerModules, compatibilityDate: '2026-10-30',
    compatibilityFlags: ['nodejs_compat'], d1Databases: { DEMO_DB: 'tabetsuna-demo-test' }
  }));
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('DEMO_DB');
  const schema = await readFile('migrations/0001_initial.sql', 'utf8');
  await db.batch(schema.trim().split(/;\s+(?=CREATE )/).map(sql => db.prepare(sql)));
  const demoSeed = await readFile('demo/initialize.sql', 'utf8');
  await db.batch(demoSeed.trim().split(/;\s+/).map(sql => db.prepare(sql)));

  function request(path, options = {}) {
    const { method = 'GET', body, cookie } = options;
    return mf.dispatchFetch(appUrl + '/api/' + path, {
      method,
      headers: { Origin: appUrl, 'Content-Type': 'application/json', ...(cookie && { Cookie: cookie }) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  }
  const state = async cookie => {
    const res = await request('state', { cookie });
    assert.equal(res.status, 200, await res.clone().text());
    return res.json();
  };
  const [first, second] = await Promise.all([state(), state()]);
  assert.deepEqual(first, second);
  const { accounts, password } = first.demo;
  assert.deepEqual(accounts.map(([, id]) => id), ['hidamari', 'aozora', 'staff']);
  const [hidamari, aozora, staff] = await Promise.all(accounts.map(async ([, login]) => {
    const res = await request('login', { method: 'POST', body: { login, password } });
    assert.equal(res.status, 200, await res.clone().text());
    return res.headers.get('Set-Cookie').split(';')[0];
  }));
  assert.deepEqual((await state(hidamari)).session.sites, ['suga']);
  const member = await state(aozora);
  assert.deepEqual(member.session.sites, ['sano']);
  assert.equal(member.session.mustChange, false);
  assert.equal((await state(staff)).products.length, 6);
  const food = member.products[0];
  const booked = await request('bookings', { method: 'POST', cookie: aozora, body: {
    use: today, slot: firstSlot, requestId: crypto.randomUUID(),
    items: [{ product: food.id, count: 1 }]
  } });
  assert.equal(booked.status, 204, await booked.text());
  const staffData = await state(staff);
  assert.equal(staffData.bookings.length, 1);
  assert.equal(staffData.products.find(item => item.id === food.id).stock, food.stock - 1);
  assert.equal((await state(hidamari)).bookings.length, 0);

  for (const [path, method] of [['password','PUT'], ['accounts','POST'], ['setup','POST']]) {
    assert.equal((await request(path, { method, cookie: staff, body: {} })).status, 403);
  }
  await db.prepare("UPDATE demo_calendar SET refreshed_on = '2000-01-01'").run();
  const [nextMember, nextStaff] = await Promise.all([state(aozora), state(staff)]);
  assert.equal(nextMember.products.find(item => item.name === food.name).stock, food.stock);
  assert.equal(nextStaff.products.length, 6);
  assert.equal(nextStaff.bookings.length, 0);
});

test('Browser entry point uses the Worker API and contains no demo account or local database', async () => {
  const html = await readFile('public/index.html','utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  assert.doesNotThrow(() => new vm.Script(script));
  assert.match(script, /fetch\('\/api\//);
  assert.doesNotMatch(script, /localStorage|demo2026|staffLogin/);
});
