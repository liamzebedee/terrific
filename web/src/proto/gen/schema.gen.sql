-- GENERATED from src/proto/models/database.proto — do not edit by hand.

CREATE TABLE IF NOT EXISTS t1 (   -- users
  f1 INTEGER PRIMARY KEY, -- id
  f2 TEXT,                -- email
  f3 TEXT,                -- username
  f4 TEXT,                -- passwordHash
  f5 TEXT                 -- uid
);
CREATE VIEW IF NOT EXISTS "users" AS
SELECT
  f1 AS "id",
  f2 AS "email",
  f3 AS "username",
  f4 AS "passwordHash",
  f5 AS "uid"
FROM t1;

CREATE TABLE IF NOT EXISTS t2 (   -- items
  f1 TEXT PRIMARY KEY, -- id
  f2 INTEGER,          -- owner
  f3 TEXT,             -- name
  f4 TEXT,             -- description
  f5 REAL              -- createdAt
);
CREATE VIEW IF NOT EXISTS "items" AS
SELECT
  f1 AS "id",
  f2 AS "owner",
  f3 AS "name",
  f4 AS "description",
  f5 AS "createdAt"
FROM t2;
