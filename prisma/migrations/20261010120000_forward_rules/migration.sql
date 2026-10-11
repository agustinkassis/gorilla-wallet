-- CreateTable
CREATE TABLE "ForwardRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "walletId" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "fromAddress" TEXT NOT NULL,
    "toAddress" TEXT NOT NULL,
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

-- CreateTable
CREATE TABLE "ForwardRun" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "ruleId" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL,
    "reason" TEXT,
    "txid" TEXT,
    "amount" BIGINT,
    "fee" BIGINT,
    "feeRate" REAL,
    "inputs" TEXT NOT NULL DEFAULT '[]',
    "dataHex" TEXT
);

-- CreateIndex
CREATE INDEX "ForwardRun_ruleId_startedAt_idx" ON "ForwardRun"("ruleId", "startedAt");
