-- 站內自行註冊的帳號走 provider='email'、provider_uid=小寫 email，
-- 重複註冊由現有的 (provider, provider_uid) 唯一約束擋下。
-- password_hash 只對 email 帳號有值；GitHub / Google 帳號維持 NULL。
-- 密碼以 PBKDF2-SHA256（10 萬次迭代 + 每使用者獨立 salt）雜湊存放，
-- Worker 端直接用 Web Crypto deriveBits，不需要額外依賴。
ALTER TABLE users ADD COLUMN password_hash TEXT;
