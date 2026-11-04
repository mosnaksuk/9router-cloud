const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

console.log("[Launcher] Starting 9Router with Real-time Cloud Sync & Key Seeder...");

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

// Known static fallback keys (ensures zero data loss even if GitHub is unreachable)
const STATIC_KEYS = [
  {
    id: "static-secure-primary-key",
    key: "sk-3e5e623503fec61e-60m0mu-94bd36a8",
    name: "Fitbit Production Key",
    machineId: "3e5e623503fec61e"
  },
  {
    id: "eb610eac-566b-4f16-a318-55e47a4ad471",
    key: "sk-ba0406de105c6bd1-63vsz0-ec40c926",
    name: "FF-build",
    machineId: "ba0406de105c6bd1"
  }
];

const GITHUB_REPO = process.env.GITHUB_DATA_REPO || "mosnaksuk/9router-data";
const GITHUB_TOKEN = process.env.GITHUB_DATA_TOKEN || "";

let currentRemoteSha = null;

/**
 * Fetch latest backup from GitHub private storage and restore to SQLite
 */
async function restoreFromGitHub(db) {
  if (!GITHUB_TOKEN) return false;
  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/backup.json`, {
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "9Router-CloudSync"
      }
    });

    if (!res.ok) {
      console.log(`[AutoSync] GitHub backup check returned HTTP ${res.status}`);
      return false;
    }

    const fileData = await res.json();
    currentRemoteSha = fileData.sha;
    const rawJson = Buffer.from(fileData.content, "base64").toString("utf8");
    const payload = JSON.parse(rawJson);

    // Restore API Keys
    if (Array.isArray(payload.apiKeys)) {
      for (const k of payload.apiKeys) {
        db.prepare(`
          INSERT OR REPLACE INTO apiKeys (id, key, name, machineId, isActive, createdAt, accessRestricted, accessAllow)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          k.id,
          k.key,
          k.name || "API Key",
          k.machineId || "cloud",
          k.isActive ? 1 : 0,
          k.createdAt || new Date().toISOString(),
          k.access?.restricted ? 1 : 0,
          JSON.stringify(k.access?.allow || [])
        );
      }
      console.log(`[AutoSync] ✅ Restored ${payload.apiKeys.length} API keys from GitHub Storage.`);
    }

    // Restore Providers
    if (Array.isArray(payload.providerConnections)) {
      for (const c of payload.providerConnections) {
        const { id, provider, authType, name, email, priority, isActive, createdAt, updatedAt, ...rest } = c;
        db.prepare(`
          INSERT OR REPLACE INTO providerConnections (id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id,
          provider,
          authType || "oauth",
          name || email || provider,
          email || null,
          priority || 1,
          isActive ? 1 : 0,
          JSON.stringify(rest),
          createdAt || new Date().toISOString(),
          updatedAt || new Date().toISOString()
        );
      }
      console.log(`[AutoSync] ✅ Restored ${payload.providerConnections.length} providers from GitHub Storage.`);
    }

    return true;
  } catch (err) {
    console.error("[AutoSync] Restore failed:", err.message);
    return false;
  }
}

/**
 * Watch SQLite database in real-time. Whenever keys or providers change,
 * push the update immediately to GitHub private storage.
 */
function startRealtimeWatcher(dbPath) {
  if (!GITHUB_TOKEN) {
    console.log("[AutoSync] GITHUB_DATA_TOKEN not provided; realtime GitHub sync disabled.");
    return;
  }

  const { DatabaseSync } = require("node:sqlite");
  let lastHash = "";
  let isSyncing = false;

  console.log(`[AutoSync] 🚀 Real-time Cloud Sync active! Watching ${GITHUB_REPO}...`);

  setInterval(async () => {
    if (isSyncing) return;
    try {
      if (!fs.existsSync(dbPath)) return;
      const db = new DatabaseSync(dbPath);

      // Verify tables exist
      const hasKeys = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='apiKeys'").get();
      const hasConns = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='providerConnections'").get();
      if (!hasKeys || !hasConns) {
        db.close();
        return;
      }

      const keys = db.prepare("SELECT * FROM apiKeys ORDER BY id").all();
      const providers = db.prepare("SELECT * FROM providerConnections ORDER BY id").all();
      db.close();

      const snapshot = JSON.stringify({ keys, providers });
      const currentHash = crypto.createHash("md5").update(snapshot).digest("hex");

      if (!lastHash) {
        lastHash = currentHash;
        return;
      }

      // If change detected (added, deleted, modified)
      if (currentHash !== lastHash) {
        isSyncing = true;
        console.log(`[AutoSync] 🔄 Change detected in Keys (${keys.length}) / Providers (${providers.length})! Syncing to GitHub...`);

        const payload = {
          apiKeys: keys.map((r) => ({
            id: r.id,
            key: r.key,
            name: r.name,
            machineId: r.machineId,
            isActive: r.isActive === 1,
            createdAt: r.createdAt,
            access: {
              restricted: r.accessRestricted === 1,
              allow: typeof r.accessAllow === "string" ? JSON.parse(r.accessAllow || "[]") : []
            }
          })),
          providerConnections: providers.map((r) => {
            let extra = {};
            try { extra = JSON.parse(r.data || "{}"); } catch {}
            return {
              ...extra,
              id: r.id,
              provider: r.provider,
              authType: r.authType,
              name: r.name,
              email: r.email,
              priority: r.priority,
              isActive: r.isActive === 1,
              createdAt: r.createdAt,
              updatedAt: r.updatedAt
            };
          })
        };

        const b64 = Buffer.from(JSON.stringify(payload, null, 2)).toString("base64");

        // Ensure we have current sha
        if (!currentRemoteSha) {
          try {
            const check = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/backup.json`, {
              headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: "application/vnd.github.v3+json", "User-Agent": "9Router-CloudSync" }
            });
            if (check.ok) {
              const info = await check.json();
              currentRemoteSha = info.sha;
            }
          } catch {}
        }

        const putRes = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/backup.json`, {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${GITHUB_TOKEN}`,
            Accept: "application/vnd.github.v3+json",
            "Content-Type": "application/json",
            "User-Agent": "9Router-CloudSync"
          },
          body: JSON.stringify({
            message: `Auto-sync: keys=${keys.length}, providers=${providers.length} [${new Date().toISOString()}]`,
            content: b64,
            ...(currentRemoteSha ? { sha: currentRemoteSha } : {})
          })
        });

        if (putRes.ok) {
          const putData = await putRes.json();
          currentRemoteSha = putData.content?.sha || currentRemoteSha;
          lastHash = currentHash;
          console.log(`[AutoSync] ✅ Cloud backup updated successfully!`);
        } else {
          const errText = await putRes.text();
          console.error("[AutoSync] Sync update failed:", errText);
          // Invalidate sha to fetch fresh on retry
          currentRemoteSha = null;
        }
      }
    } catch (e) {
      // Ignore background read errors
    } finally {
      isSyncing = false;
    }
  }, 4000); // Check every 4 seconds
}

/**
 * Startup seeder: Wait for SQLite to initialize, restore from GitHub or fallback
 */
async function initStorage() {
  const dbPath = path.join(process.env.DATA_DIR || "/app/data", "db", "data.sqlite");

  for (let attempt = 1; attempt <= 40; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 2000));

    try {
      if (!fs.existsSync(dbPath)) continue;

      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(dbPath);

      const tableCheck = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='apiKeys'").get();
      const connCheck = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='providerConnections'").get();
      if (!tableCheck || !connCheck) {
        db.close();
        continue;
      }

      // 1. Try to restore from GitHub private cloud backup
      const restored = await restoreFromGitHub(db);

      // 2. Fallback static keys (always ensure user keys exist)
      for (const k of STATIC_KEYS) {
        const existing = db.prepare("SELECT key FROM apiKeys WHERE key = ?").get(k.key);
        if (!existing) {
          db.prepare(`
            INSERT OR REPLACE INTO apiKeys (id, key, name, machineId, isActive, createdAt, accessRestricted, accessAllow)
            VALUES (?, ?, ?, ?, 1, ?, 0, NULL)
          `).run(k.id, k.key, k.name, k.machineId, new Date().toISOString());
          console.log(`[KeySeeder] ✅ Locked core key: ${k.name} (${k.key})`);
        }
      }

      // 3. Fallback Antigravity OAuth connection
      const refreshToken = process.env.ANTIGRAVITY_REFRESH_TOKEN;
      if (refreshToken) {
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
          console.log("[KeySeeder] ✅ Locked Antigravity OAuth connection from environment!");
        }
      }

      db.close();
      console.log("[Launcher] ✅ Database initialization and initial seed finished.");

      // Start continuous background sync watcher
      startRealtimeWatcher(dbPath);
      break;
    } catch (err) {
      // Continue polling until SQLite is ready
    }
  }
}

// Start background initialization
initStorage().catch((err) => {
  console.error("[Launcher] Unexpected error in initStorage:", err);
});
