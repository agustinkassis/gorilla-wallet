-- eCash Beta (pECX) is gone: its chain stopped at block 974,075 on 2026-10-31 and its servers are offline.
-- Drop its synced data and labels, and move settings that still name it to eCash (ECX), its successor.
DELETE FROM "AddressState" WHERE "chain" = 'pecx';
DELETE FROM "Utxo" WHERE "chain" = 'pecx';
DELETE FROM "Tx" WHERE "chain" = 'pecx';
DELETE FROM "RawTx" WHERE "chain" = 'pecx';
DELETE FROM "Header" WHERE "chain" = 'pecx';
DELETE FROM "Label" WHERE "chain" = 'pecx';

UPDATE "Setting" SET "value" = '"ecx"' WHERE "key" = 'chain' AND "value" = '"pecx"';
UPDATE "Setting" SET "value" = (SELECT json_group_array(j."value") FROM json_each("Setting"."value") j WHERE j."value" <> 'pecx')
  WHERE "key" = 'hidden' AND json_valid("value") AND json_type("value") = 'array';
UPDATE "Setting" SET "value" = json_remove("value", '$.pecx')
  WHERE "key" = 'sources' AND json_valid("value") AND json_type("value") = 'object';
