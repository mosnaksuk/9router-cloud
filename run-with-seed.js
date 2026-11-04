const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

console.log("[Launcher] Starting 9Router with Persistent Key & Provider Seeder...");

// 1. Start custom-server.js
const child = spawn("node", ["custom-server.js", ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
});

child.on("exit", (code, signal) => {
  console.log(`[Launcher] 9Router exited with code: ${code}, signal: ${signal}`);
  process.exit(code || 0);
});

process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));

// 2. User's chosen secure random API key
const PRIMARY_KEY = process.env.STATIC_API_KEY || "sk-3e5e623503fec61e-60m0mu-94bd36a8";

async function seedKeys() {
  const dbPath = path.join(process.env.DATA_DIR || "/app/data", "db", "data.sqlite");

  for (let attempt = 1; attempt <= 40; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 2000));

    try {
      if (!fs.existsSync(dbPath)) {
        continue;
      }

      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(dbPath);

      // Verify table exists
      const tableCheck = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='apiKeys'").get();
      if (!tableCheck) {
        continue;
      }

      // Remove any predictable / weak legacy keys
      db.prepare("DELETE FROM apiKeys WHERE key LIKE '%fitbit-master%' OR id = 'static-fitbit-master-key'").run();

      // Ensure primary secure key is active
      const existing = db.prepare("SELECT key FROM apiKeys WHERE key = ?").get(PRIMARY_KEY);
      if (!existing) {
        db.prepare(`
          INSERT OR REPLACE INTO apiKeys (id, key, name, machineId, isActive, createdAt, accessRestricted, accessAllow)
          VALUES (?, ?, ?, ?, 1, ?, 0, NULL)
        `).run("static-secure-primary-key", PRIMARY_KEY, "Fitbit Production Key", "3e5e623503fec61e", new Date().toISOString());
        console.log(`[KeySeeder] ✅ Successfully locked secure API key: ${PRIMARY_KEY}`);
      } else {
        console.log(`[KeySeeder] Secure API key active: ${PRIMARY_KEY}`);
      }

      // 3. Seed providerConnections for Antigravity from environment variable
      const connTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='providerConnections'").get();
      const refreshToken = process.env.ANTIGRAVITY_REFRESH_TOKEN;
      if (connTable && refreshToken) {
        const existingConn = db.prepare("SELECT id FROM providerConnections WHERE provider = 'antigravity'").get();
        if (!existingConn) {
          const email = process.env.ANTIGRAVITY_EMAIL || "mos.naksuk@gmail.com";
          const connDataObj = {
            accessToken: process.env.ANTIGRAVITY_ACCESS_TOKEN || "",
            refreshToken: refreshToken,
            scope: "https://www.googleapis.com/auth/cclog https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/experimentsandconfigs https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile openid",
            projectId: "aicode-consumers",
            testStatus: "active",
            expiresIn: 3599,
            expiresAt: new Date(Date.now() + 3600000).toISOString()
          };
          db.prepare(`
            INSERT OR REPLACE INTO providerConnections (id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt)
            VALUES (?, 'antigravity', 'oauth', ?, ?, 1, 1, ?, datetime('now'), datetime('now'))
          `).run("4a289910-1059-4f64-b448-95593bba4da4", email, email, JSON.stringify(connDataObj));
          console.log("[KeySeeder] ✅ Successfully locked Antigravity OAuth connection from environment!");
        } else {
          console.log("[KeySeeder] Antigravity OAuth connection active.");
        }
      }

      // 4. Seed generic providerConnections from STATIC_PROVIDERS_JSON (supports any provider)
      if (connTable && process.env.STATIC_PROVIDERS_JSON) {
        try {
          const list = JSON.parse(process.env.STATIC_PROVIDERS_JSON);
          for (const p of (Array.isArray(list) ? list : [list])) {
            const { id, provider, authType, name, email, priority, isActive, createdAt, updatedAt, ...rest } = p;
            db.prepare(`
              INSERT OR REPLACE INTO providerConnections (id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
            `).run(
              id || `seed-${provider}`,
              provider,
              authType || (rest.apiKey ? "apikey" : "oauth"),
              name || email || provider,
              email || null,
              priority || 1,
              isActive === false ? 0 : 1,
              JSON.stringify(rest)
            );
            console.log(`[KeySeeder] ✅ Seeded provider from JSON: ${provider} (${name || email})`);
          }
        } catch (e) {
          console.error("[KeySeeder] Failed to parse STATIC_PROVIDERS_JSON:", e.message);
        }
      }

      db.close();
      console.log("[KeySeeder] Verification finished.");
      break;
    } catch (err) {
      // Continue polling until SQLite is ready
    }
  }
}

// Run key seeder in background
seedKeys().catch((err) => {
  console.error("[KeySeeder] Unexpected error in seeder:", err);
});
