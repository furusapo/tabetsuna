CREATE TABLE IF NOT EXISTS demo_calendar (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  refreshed_on TEXT NOT NULL
);

INSERT OR IGNORE INTO demo_calendar VALUES (1, '');

INSERT OR IGNORE INTO organizations (id, name) VALUES
  ('da300000-0000-4000-8000-000000000001', 'ひだまり子ども食堂'),
  ('da300000-0000-4000-8000-000000000002', 'あおぞら子ども食堂');

-- Scrypt hash of the shared public password for these demo accounts only.
INSERT OR IGNORE INTO accounts (login, password_hash, role, organization_id, staff_site)
SELECT login, 'scrypt$e714422c50added3917b1430ac22ca87$d3fbbd38b7afecf6a46926d82cf1236f705718ac683d18ffc47a3590610d70a5',
       role, organization_id, staff_site
FROM (
  SELECT 'hidamari' AS login, 'member' AS role, 'da300000-0000-4000-8000-000000000001' AS organization_id, NULL AS staff_site
  UNION ALL SELECT 'aozora', 'member', 'da300000-0000-4000-8000-000000000002', NULL
  UNION ALL SELECT 'staff', 'staff', NULL, 'all'
);
