-- 唯一约束建在 (provider, provider_uid) 而不是 email：GitHub 用户可以把邮箱
-- 设为私有，此时 /user 和 /user/emails 都可能拿不到地址，email 必须允许为空。
CREATE TABLE users (
  id           TEXT    PRIMARY KEY,
  provider     TEXT    NOT NULL,
  provider_uid TEXT    NOT NULL,
  login        TEXT    NOT NULL,
  email        TEXT,
  avatar_url   TEXT,
  role         TEXT    NOT NULL DEFAULT 'user',
  created_at   INTEGER NOT NULL,
  UNIQUE (provider, provider_uid)
);

CREATE TABLE feedback (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target      TEXT,
  content     TEXT    NOT NULL,
  status      TEXT    NOT NULL DEFAULT 'new',
  created_at  INTEGER NOT NULL,
  reviewed_at INTEGER
);

-- cron 每周按 (status, created_at) 扫一次待 review 的行，投稿限流按
-- (user_id, created_at) 数最近一小时的条数。没有这两个索引就是全表扫描，
-- 免费版 500 万行读/天会被这类定时任务悄悄吃光。
CREATE INDEX idx_feedback_review ON feedback (status, created_at);
CREATE INDEX idx_feedback_user   ON feedback (user_id, created_at);
