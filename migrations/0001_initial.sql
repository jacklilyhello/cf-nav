CREATE TABLE categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  sortOrder INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  updatedAt TEXT NOT NULL,
  deletedAt TEXT
);
CREATE TABLE links (
  id TEXT PRIMARY KEY,
  categoryId TEXT NOT NULL REFERENCES categories(id),
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  icon TEXT NOT NULL DEFAULT '',
  sortOrder INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  featured INTEGER NOT NULL DEFAULT 0 CHECK(featured IN (0,1)),
  notes TEXT NOT NULL DEFAULT '',
  expectedKeywords TEXT NOT NULL DEFAULT '[]',
  healthStatus TEXT NOT NULL DEFAULT 'unknown',
  healthOverride TEXT,
  checkDisabled INTEGER NOT NULL DEFAULT 0 CHECK(checkDisabled IN (0,1)),
  lastCheckedAt TEXT,
  lastSuccessAt TEXT,
  lastFailureAt TEXT,
  nextCheckAt TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z',
  finalUrl TEXT,
  httpStatus INTEGER,
  consecutiveFailures INTEGER NOT NULL DEFAULT 0,
  lastError TEXT,
  observedTitle TEXT,
  confirmedTitle TEXT,
  healthEvidence TEXT NOT NULL DEFAULT '[]',
  checkLeaseUntil TEXT,
  updatedAt TEXT NOT NULL,
  deletedAt TEXT
);
CREATE UNIQUE INDEX links_active_url ON links(url) WHERE deletedAt IS NULL;
CREATE INDEX links_due ON links(checkDisabled,deletedAt,nextCheckAt);
CREATE INDEX links_category ON links(categoryId,sortOrder);
CREATE TABLE health_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  linkId TEXT NOT NULL REFERENCES links(id),
  status TEXT NOT NULL,
  httpStatus INTEGER,
  finalUrl TEXT,
  title TEXT,
  evidence TEXT NOT NULL,
  checkedAt TEXT NOT NULL,
  durationMs INTEGER NOT NULL
);
CREATE INDEX health_history_link ON health_history(linkId,checkedAt DESC);
CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  expiresAt INTEGER NOT NULL
);
CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  targetId TEXT NOT NULL,
  occurredAt TEXT NOT NULL
);
CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
