# Telegram staging deployment

Operator-only procedure for the concrete host bridge. Never paste Telegram codes, 2FA passwords,
TDLib database files, HMAC values, or Access service-token secrets into git or chat.

1. Provision a pinned TDLib JSON client binary/container and record its version/checksum in the
   protected operator manifest.
2. Create the isolated D1 database, then run from the repository root:

   ```powershell
   .\scripts\deploy\apply-mvp1-migrations.ps1 -DatabaseName <staging-db> -Remote
   ```

3. Deploy Workers with their corresponding Wrangler configs and replace every
   `REPLACE_WITH_REAL_D1_DATABASE_ID` placeholder before deployment:

   ```powershell
   npx wrangler deploy --config infra/cloudflare/ingest.wrangler.toml
   npx wrangler deploy --config infra/cloudflare/processor.wrangler.toml
   npx wrangler deploy --config infra/cloudflare/gmail-connector.wrangler.toml
   npx wrangler deploy --config infra/cloudflare/tunnel-gateway.wrangler.toml
   ```

4. Provision `TELEGRAM_V1_HMAC_SECRET`, `ACCESS_CLIENT_ID`, and `ACCESS_CLIENT_SECRET` using the
   platform secret manager. Configure the Cloudflare Access service token and Tunnel route to the
   gateway Worker; verify only metadata/status is present in logs.
5. Start a supervised host process using `TelegramTdlibProcessClient`, `TelegramConnectorRuntime`,
   `TelegramSpool`, and `createTelegramIngestDeliver`. Keep the spool/TDLib database on encrypted
   persistent storage.
6. Run Telegram authorization interactively on the host terminal. Record only a redacted account
   fingerprint and timestamps. Then execute reconnect, burst-overflow, restart, and ingest ACK
   checks from `MVP1_REAL_DEVICE_ACCOUNT_TEST.md`.

The repository supplies the process bridge and deployment scaffolding; production credentials,
TDLib binary provisioning, Cloudflare account state, and operator GO remain external evidence.
