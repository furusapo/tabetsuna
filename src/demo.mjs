export const demoLogin = {
  accounts: [
    ['ひだまり子ども食堂（須賀食品）', 'hidamari'],
    ['あおぞら子ども食堂（豆心フーズ）', 'aozora'],
    ['スタッフ（両拠点）', 'staff']
  ],
  password: 'demo2026'
};

const profiles = [
  ['hidamari', '埼玉県', '川口市', '3320017'],
  ['aozora', '栃木県', '佐野市', '3270843']
];

const foods = [
  ['suga', 'たまご 10個入り', '賞味期限', 2, 18, 'パック'],
  ['suga', 'キャベツ', '賞味期限', 6, 12, '玉'],
  ['suga', 'にんじん', '賞味期限', 9, 24, '袋'],
  ['suga', '木綿豆腐', '消費期限', 1, 8, '丁'],
  ['sano', '食パン 6枚切り', '消費期限', 2, 14, '袋'],
  ['sano', 'じゃがいも', '賞味期限', 10, 16, '袋']
];

export async function refreshDemo(db, day) {
  const lastDay = await db.prepare('SELECT refreshed_on FROM demo_calendar WHERE id = 1').first('refreshed_on');
  if (lastDay === null) throw new Error('Demo database must be initialized before use');
  if (lastDay >= day) return;

  // Recheck the date in the transaction so parallel requests can't reset new bookings.
  const due = '(SELECT refreshed_on FROM demo_calendar WHERE id = 1) < ?';
  await db.batch([
    db.prepare('DELETE FROM bookings WHERE ' + due).bind(day),
    db.prepare('DELETE FROM booking_batches WHERE ' + due).bind(day),
    db.prepare('DELETE FROM products WHERE ' + due).bind(day),
    ...profiles.map(([login, prefecture, city, postalCode]) => db.prepare(`
      UPDATE organizations
      SET prefecture = ?, city = ?, address = 'デモ町1-2-3', contact_name = 'デモ担当', postal_code = ?
      WHERE id = (SELECT organization_id FROM accounts WHERE login = ?) AND ${due}
    `).bind(prefecture, city, postalCode, login, day)),
    ...foods.map(([site, name, kind, days, stock, unit]) => db.prepare(`
      INSERT INTO products(id, site, name, kind, expires, stock, unit)
      SELECT ?, ?, ?, ?, date(?, ?), ?, ? WHERE ${due}
    `).bind(crypto.randomUUID(), site, name, kind, day, '+' + days + ' days', stock, unit, day)),
    db.prepare('UPDATE demo_calendar SET refreshed_on = ? WHERE id = 1 AND refreshed_on < ?').bind(day, day)
  ]);
}
