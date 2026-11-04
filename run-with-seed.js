const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

console.log("[Launcher] Starting 9Router with Persistent Key Seeder...");

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

      db.close();
      console.log("[KeySeeder] Key verification finished.");
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
