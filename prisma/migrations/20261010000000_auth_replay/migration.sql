CREATE TABLE "AuthEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "expiresAt" INTEGER NOT NULL
);
CREATE INDEX "AuthEvent_expiresAt_idx" ON "AuthEvent"("expiresAt");
