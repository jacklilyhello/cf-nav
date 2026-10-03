-- Durable cooldown/redirect cursors. Existing links, settings and history remain intact.
CREATE TABLE health_jobs (
  linkId TEXT PRIMARY KEY REFERENCES links(id),
  url TEXT NOT NULL,
  linkUpdatedAt TEXT NOT NULL,
  settings TEXT NOT NULL,
  cursor TEXT,
  nextRequestAt INTEGER NOT NULL DEFAULT 0,
  manual INTEGER NOT NULL DEFAULT 0 CHECK(manual IN (0,1)),
  createdAt TEXT NOT NULL
);
CREATE INDEX health_jobs_due ON health_jobs(nextRequestAt,manual,createdAt);
