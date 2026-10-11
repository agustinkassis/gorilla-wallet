-- Address labels belong to one chain, like tx/output labels. Old shared ("all") address labels were mainnet-only:
-- each becomes a Bitcoin and a Blake label, which can then be edited independently.
INSERT OR IGNORE INTO "Label" ("walletId", "chain", "type", "ref", "label", "spendable")
  SELECT "walletId", 'btc', "type", "ref", "label", "spendable" FROM "Label" WHERE "chain" = 'all';
INSERT OR IGNORE INTO "Label" ("walletId", "chain", "type", "ref", "label", "spendable")
  SELECT "walletId", 'xbt', "type", "ref", "label", "spendable" FROM "Label" WHERE "chain" = 'all';
DELETE FROM "Label" WHERE "chain" = 'all';
