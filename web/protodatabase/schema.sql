-- GENERATED from proto/db/v1/database.proto — do not edit by hand.
-- Regenerate:  bun protodatabase/codegen.ts

CREATE TABLE IF NOT EXISTS t1 (   -- meals
  f1 TEXT PRIMARY KEY, -- id
  f2 TEXT,             -- name
  f3 TEXT,             -- ingredients
  f4 TEXT              -- list
);
CREATE VIEW IF NOT EXISTS "meals" AS
SELECT
  f1 AS "id",
  f2 AS "name",
  f3 AS "ingredients",
  f4 AS "list"
FROM t1;

CREATE TABLE IF NOT EXISTS t2 (   -- nutrition
  f1 TEXT, -- key
  f2 BLOB  -- macros (bytes)
);
CREATE VIEW IF NOT EXISTS "nutrition" AS
SELECT
  f1 AS "key",
  f2 AS "macros"
FROM t2;

CREATE TABLE IF NOT EXISTS t3 (   -- profile
  f1 BLOB, -- user (bytes)
  f2 BLOB, -- method (bytes)
  f3 BLOB, -- computed (bytes)
  f4 REAL, -- proteinDiv
  f5 REAL  -- fatDiv
);
CREATE VIEW IF NOT EXISTS "profile" AS
SELECT
  f1 AS "user",
  f2 AS "method",
  f3 AS "computed",
  f4 AS "proteinDiv",
  f5 AS "fatDiv"
FROM t3;

CREATE TABLE IF NOT EXISTS t4 (   -- daysim
  f1 BLOB, -- slots (bytes)
  f2 REAL, -- wake
  f3 REAL, -- bed
  f4 REAL, -- startBg
  f5 REAL, -- bolusRatio
  f6 REAL, -- correctionRatio
  f7 BLOB, -- meals (bytes)
  f8 BLOB  -- boluses (bytes)
);
CREATE VIEW IF NOT EXISTS "daysim" AS
SELECT
  f1 AS "slots",
  f2 AS "wake",
  f3 AS "bed",
  f4 AS "startBg",
  f5 AS "bolusRatio",
  f6 AS "correctionRatio",
  f7 AS "meals",
  f8 AS "boluses"
FROM t4;

CREATE TABLE IF NOT EXISTS t5 (   -- settings
  f1 TEXT,    -- snacks
  f2 TEXT,    -- veggies
  f3 TEXT,    -- gym
  f4 TEXT,    -- supps
  f5 INTEGER, -- t1dFeatures
  f6 TEXT     -- lookupBackend
);
CREATE VIEW IF NOT EXISTS "settings" AS
SELECT
  f1 AS "snacks",
  f2 AS "veggies",
  f3 AS "gym",
  f4 AS "supps",
  f5 AS "t1dFeatures",
  f6 AS "lookupBackend"
FROM t5;
