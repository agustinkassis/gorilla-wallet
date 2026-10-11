-- Login allowlist is ALLOWED_PUBKEYS only: drop the keys managed in Settings and the first-login owner claim.
DROP TABLE "Account";
DELETE FROM "Setting" WHERE "key" = 'owner';
