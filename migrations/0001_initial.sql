CREATE TABLE organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  prefecture TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  contact_name TEXT NOT NULL DEFAULT '',
  postal_code TEXT NOT NULL DEFAULT '',
  site TEXT GENERATED ALWAYS AS (
    CASE prefecture WHEN '栃木県' THEN 'sano' WHEN '埼玉県' THEN 'suga' END
  ) STORED
);

CREATE TABLE accounts (
  login TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('staff', 'member')),
  organization_id TEXT UNIQUE REFERENCES organizations(id),
  staff_site TEXT CHECK (staff_site IN ('sano', 'suga', 'all')),
  must_change INTEGER NOT NULL DEFAULT 0 CHECK (must_change IN (0, 1)),
  CHECK (
    (role = 'staff' AND organization_id IS NULL AND staff_site IS NOT NULL)
    OR (role = 'member' AND organization_id IS NOT NULL AND staff_site IS NULL)
  )
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  account_login TEXT NOT NULL REFERENCES accounts(login) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_by_account ON sessions(account_login, expires_at);

CREATE TABLE setup_codes (
  token_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);

CREATE TABLE login_rate (
  rate_key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  attempts INTEGER NOT NULL
);
CREATE INDEX login_rate_by_window ON login_rate(window_start);

CREATE TABLE products (
  id TEXT PRIMARY KEY,
  site TEXT NOT NULL CHECK (site IN ('sano', 'suga')),
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('賞味期限', '消費期限')),
  expires TEXT NOT NULL,
  stock INTEGER NOT NULL CHECK (stock >= 0),
  unit TEXT NOT NULL,
  photo TEXT NOT NULL DEFAULT ''
);
CREATE INDEX products_by_site ON products(site, expires);

CREATE TABLE booking_batches (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  fingerprint TEXT NOT NULL
);

CREATE TABLE bookings (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES booking_batches(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  site TEXT NOT NULL CHECK (site IN ('sano', 'suga')),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  use_date TEXT NOT NULL,
  pickup_date TEXT NOT NULL,
  slot TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'cancelled')),
  prepared INTEGER NOT NULL DEFAULT 0 CHECK (prepared IN (0, 1)),
  handed_over_at TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX bookings_by_organization ON bookings(organization_id, created_at);
CREATE INDEX bookings_by_appointment ON bookings(site, organization_id, pickup_date, slot, status);

CREATE TRIGGER reserve_stock
BEFORE INSERT ON bookings
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM products p JOIN organizations o ON o.id = NEW.organization_id
    WHERE p.id = NEW.product_id AND p.site = NEW.site AND o.site = NEW.site
      AND p.expires >= NEW.use_date AND p.stock >= NEW.quantity
  ) THEN RAISE(ABORT, 'stock_unavailable') END;
  UPDATE products SET stock = stock - NEW.quantity WHERE id = NEW.product_id;
END;

CREATE TRIGGER return_cancelled_stock
AFTER UPDATE OF status ON bookings
WHEN OLD.status = 'pending' AND NEW.status = 'cancelled'
BEGIN
  UPDATE products SET stock = stock + NEW.quantity WHERE id = NEW.product_id;
END;
