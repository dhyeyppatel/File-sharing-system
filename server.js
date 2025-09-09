// server.js - simple bundles API (SQLite + Express) - no nanoid dependency
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const Database = require('better-sqlite3');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || ""; // set this on Render for security

// helper: generate short id (8 chars) - URL safe base36-ish
function makeId(len = 8) {
  // use random bytes, convert to base36 string, trim
  const bytes = crypto.randomBytes(Math.ceil(len * 0.6));
  return parseInt(bytes.toString('hex'), 16).toString(36).slice(0, len);
}

// open or create SQLite DB
const db = new Database('data.db');

// initialize tables
db.prepare(`
  CREATE TABLE IF NOT EXISTS bundles (
    id TEXT PRIMARY KEY,
    owner_id TEXT,
    owner_name TEXT,
    header_chat_id TEXT,
    header_msg_id INTEGER,
    created_at INTEGER,
    finalized_at INTEGER,
    files_count INTEGER DEFAULT 0
  )
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT,
    channel_msg_id INTEGER,
    header_chat_id TEXT,
    caption TEXT,
    added_at INTEGER
  )
`).run();

// simple API key middleware (if API_KEY env is set, require it)
function requireApiKey(req, res, next) {
  if (!API_KEY) return next(); // no key required if none configured
  const header = req.get('x-api-key') || req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.split(' ')[1] : header;
  if (!token) return res.status(401).json({ ok:false, error: 'Missing API key' });
  if (token !== API_KEY) return res.status(403).json({ ok:false, error: 'Invalid API key' });
  next();
}

// health
app.get('/health', (req, res) => {
  res.json({ ok: true, time: Date.now() });
});

// create bundle (POST /bundles)
app.post('/bundles', requireApiKey, (req, res) => {
  try {
    const { id, owner_id, owner_name, header_chat_id, header_msg_id, created_at } = req.body;
    const bundleId = id && id.toString().trim().length ? id.toString().trim() : makeId(8);
    const now = created_at || Date.now();
    const stmt = db.prepare(`
      INSERT INTO bundles (id, owner_id, owner_name, header_chat_id, header_msg_id, created_at, files_count)
      VALUES (?, ?, ?, ?, ?, ?, 0)
    `);
    stmt.run(bundleId, owner_id || "", owner_name || "", header_chat_id || "", header_msg_id || 0, now);
    const bundle = db.prepare(`SELECT * FROM bundles WHERE id = ?`).get(bundleId);
    res.json({ ok: true, bundle });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// add file (POST /files)
app.post('/files', requireApiKey, (req, res) => {
  try {
    const { code, channel_msg_id, header_chat_id, caption, added_at } = req.body;
    if (!code) return res.status(400).json({ ok: false, error: "Missing code" });
    const now = added_at || Date.now();
    const insert = db.prepare(`
      INSERT INTO files (code, channel_msg_id, header_chat_id, caption, added_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    const info = insert.run(code, channel_msg_id, header_chat_id || "", caption || "", now);
    // increment files_count (if bundle exists)
    db.prepare(`UPDATE bundles SET files_count = files_count + 1 WHERE id = ?`).run(code);
    res.json({
      ok: true,
      file: {
        id: info.lastInsertRowid,
        code,
        channel_msg_id,
        header_chat_id,
        caption,
        added_at: now
      }
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// get bundle (GET /bundles/:code) - optional includeFiles=1
app.get('/bundles/:code', requireApiKey, (req, res) => {
  try {
    const code = req.params.code;
    const row = db.prepare(`SELECT * FROM bundles WHERE id = ?`).get(code);
    if (!row) return res.status(404).json({ ok: false, error: 'Bundle not found' });

    if (req.query.includeFiles === '1' || req.query.includeFiles === 'true') {
      const files = db.prepare(`SELECT channel_msg_id, caption, added_at FROM files WHERE code = ? ORDER BY id ASC`).all(code);
      return res.json({ ok: true, bundle: row, files });
    }

    res.json({ ok: true, bundle: row });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// get files only (GET /bundles/:code/files)
app.get('/bundles/:code/files', requireApiKey, (req, res) => {
  try {
    const code = req.params.code;
    const files = db.prepare(`SELECT channel_msg_id, caption, added_at FROM files WHERE code = ? ORDER BY id ASC`).all(code);
    res.json({ ok: true, files });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// export bundle JSON (GET /export/:code)
app.get('/export/:code', requireApiKey, (req, res) => {
  const code = req.params.code;
  const bundle = db.prepare(`SELECT * FROM bundles WHERE id = ?`).get(code);
  if (!bundle) return res.status(404).json({ ok:false, error: 'Bundle not found' });
  const files = db.prepare(`SELECT channel_msg_id, caption, added_at FROM files WHERE code = ? ORDER BY id ASC`).all(code);
  bundle.files = files;
  res.json({ ok:true, bundle });
});

// PATCH /bundles/:code - update bundle metadata (finalized_at, files_count, header_msg_id, etc.)
app.patch('/bundles/:code', requireApiKey, (req, res) => {
  try {
    const code = req.params.code;
    const body = req.body || {};
    // Only allow certain fields to be updated
    const allowed = ['finalized_at', 'files_count', 'header_msg_id', 'header_chat_id', 'owner_name', 'owner_id'];
    const fields = Object.keys(body).filter(k => allowed.includes(k));

    if (fields.length === 0) {
      return res.status(400).json({ ok: false, error: 'No allowed fields provided' });
    }

    // Build SET clause
    const sets = fields.map(f => `${f} = ?`).join(', ');
    const values = fields.map(f => body[f]);
    values.push(code); // WHERE param

    const stmt = db.prepare(`UPDATE bundles SET ${sets} WHERE id = ?`);
    const info = stmt.run(...values);

    if (info.changes === 0) {
      return res.status(404).json({ ok: false, error: 'Bundle not found' });
    }

    const updated = db.prepare(`SELECT * FROM bundles WHERE id = ?`).get(code);
    res.json({ ok: true, bundle: updated });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /bundles/:code/finalize - convenience endpoint for bots that cannot issue PATCH
app.post('/bundles/:code/finalize', requireApiKey, (req, res) => {
  try {
    const code = req.params.code;
    const now = req.body.finalized_at || Date.now();
    const files_count = typeof req.body.files_count !== 'undefined' ? req.body.files_count : null;
    const updates = ['finalized_at = ?'];
    const values = [now];

    if (files_count !== null) {
      updates.push('files_count = ?');
      values.push(files_count);
    }

    values.push(code);
    const stmt = db.prepare(`UPDATE bundles SET ${updates.join(', ')} WHERE id = ?`);
    const info = stmt.run(...values);
    if (info.changes === 0) return res.status(404).json({ ok: false, error: 'Bundle not found' });
    const updated = db.prepare(`SELECT * FROM bundles WHERE id = ?`).get(code);
    res.json({ ok: true, bundle: updated });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});


app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
