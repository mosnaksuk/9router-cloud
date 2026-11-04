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

// 2. Static Keys to guarantee persistence across restarts/redeploys
const KEYS_TO_SEED = [
  {
    id: "static-current-default-key",
    key: process.env.STATIC_API_KEY || "sk-05b55a4936a7fcfa-zawh5i-2a8af7b8",
    name: "Permanent Default Key",
  },
  {
    id: "static-fitbit-master-key",
    key: "sk-fitbit-master-key-2026",
    name: "Fitbit Master Key",
  },
];

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

      for (const item of KEYS_TO_SEED) {
        const existing = db.prepare("SELECT key FROM apiKeys WHERE key = ?").get(item.key);
        if (!existing) {
          db.prepare(`
            INSERT OR REPLACE INTO apiKeys (id, key, name, machineId, isActive, createdAt, accessRestricted, accessAllow)
            VALUES (?, ?, ?, ?, 1, ?, 0, NULL)
          `).run(item.id, item.key, item.name, "cloud-machine", new Date().toISOString());
          console.log(`[KeySeeder] ✅ Successfully seeded static key: ${item.key} (${item.name})`);
        } else {
          console.log(`[KeySeeder] Key already active: ${item.key}`);
        }
      }

      db.close();
      console.log("[KeySeeder] All permanent keys verified and ready.");
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
