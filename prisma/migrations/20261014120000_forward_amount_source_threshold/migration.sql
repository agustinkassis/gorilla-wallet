-- SQLite needs a table rebuild to make the source nullable. Keep rule ids, cron lines and history intact.
CREATE TABLE "new_ForwardRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "walletId" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "fromAddress" TEXT,
    "toAddress" TEXT NOT NULL,
    "amountSats" BIGINT,
    "balanceAboveSats" BIGINT,
    "everyMinutes" INTEGER NOT NULL,
    "minConf" INTEGER NOT NULL DEFAULT 1,
    "maxFeeRate" REAL NOT NULL,
    "message" TEXT,
    "passwordFile" TEXT,
    "cronLine" TEXT NOT NULL,
    "logFile" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastCheckedAt" DATETIME,
    "runningUntil" DATETIME
);
INSERT INTO "new_ForwardRule" ("id", "walletId", "chain", "fromAddress", "toAddress", "everyMinutes", "minConf", "maxFeeRate", "message", "passwordFile", "cronLine", "logFile", "createdAt", "lastCheckedAt", "runningUntil")
SELECT "id", "walletId", "chain", "fromAddress", "toAddress", "everyMinutes", "minConf", "maxFeeRate", "message", "passwordFile", "cronLine", "logFile", "createdAt", "lastCheckedAt", "runningUntil" FROM "ForwardRule";
DROP TABLE "ForwardRule";
ALTER TABLE "new_ForwardRule" RENAME TO "ForwardRule";
CREATE INDEX "ForwardRule_walletId_chain_idx" ON "ForwardRule"("walletId", "chain");

ALTER TABLE "ForwardRun" ADD COLUMN "observedBalance" BIGINT;

CREATE TABLE "ForwardLease" (
    "walletId" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    PRIMARY KEY ("walletId", "chain")
);
