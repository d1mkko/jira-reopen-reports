// server.js
import express from 'express';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import crypto from 'crypto';
import { nanoid } from 'nanoid';
import { execFile } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import AdmZip from 'adm-zip';
import { fileURLToPath } from 'url';

dotenv.config();

const pkceMap = new Map(); 

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(cookieParser());

// ---- Config ----
const PORT = Number(process.env.PORT || 3000);
const PYTHON = process.env.PYTHON_BIN || 'python3';

// PAT fallback (used if no OAuth session)
const JIRA_BASE_URL  = process.env.JIRA_BASE_URL || '';
const JIRA_EMAIL     = process.env.JIRA_EMAIL || '';
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN || '';

// Optional custom-field overrides
const REOPEN_COUNT_ID   = process.env.REOPEN_COUNT_ID;
const REOPEN_LOG_ID     = process.env.REOPEN_LOG_ID;
const REOPEN_COUNT_NAME = process.env.REOPEN_COUNT_NAME;
const REOPEN_LOG_NAME   = process.env.REOPEN_LOG_NAME;

// OAuth (3LO PKCE)
const ATLASSIAN_CLIENT_ID = process.env.ATLASSIAN_CLIENT_ID || '';
const CALLBACK_URL = process.env.ATLASSIAN_CALLBACK_URL || `http://localhost:${PORT}/auth/callback`;
const OAUTH_AUTH  = 'https://auth.atlassian.com/authorize';
const OAUTH_TOKEN = 'https://auth.atlassian.com/oauth/token';
const OAUTH_RES   = 'https://api.atlassian.com/oauth/token/accessible-resources';

// In-memory token store (local single-user dev)
const oauth = {
  access_token: null,
  refresh_token: null,
  expires_at: 0,  // epoch ms
  cloud_id: null,
  account: null,  // { name, url }
};

// ---- Helpers ----
function b64url(buf) {
  return buf.toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function genCodeVerifier() { return b64url(crypto.randomBytes(32)); }
function sha256(input) { return crypto.createHash('sha256').update(input).digest(); }
function now() { return Date.now(); }

function setPkceCookie(res, data) {
  res.cookie('pkce', JSON.stringify(data), {
    httpOnly: true,
    sameSite: 'Lax',
    secure: false,        // set true if serving over https
    maxAge: 5 * 60 * 1000,
    path: '/',
  });
}
function clearPkceCookie(res) {
  res.clearCookie('pkce', { path: '/' });
}

async function fetchJSON(url, opts = {}) {
  const r = await fetch(url, opts);
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { ok: r.ok, status: r.status, data, text };
}

function runPy(file, args = [], extraEnv = {}) {
  return new Promise((resolve, reject) => {
    execFile(PYTHON, [file, ...args], { env: { ...process.env, ...extraEnv } }, (err, stdout, stderr) => {
      if (err) {
        const tail = (stderr || stdout || '').toString().split('\n').slice(-20).join('\n');
        return reject(new Error(`${path.basename(file)} failed:\n${tail}`));
      }
      resolve({ stdout, stderr });
    });
  });
}

// ---- AUTH ROUTES ----
app.get('/auth/login', (req, res) => {
  if (!ATLASSIAN_CLIENT_ID) return res.status(500).send('Missing ATLASSIAN_CLIENT_ID in .env');

  const state = nanoid(16);
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());

  // cookie (primary)
  setPkceCookie(res, { state, verifier, createdAt: Date.now() });
  // in-memory fallback
  pkceMap.set(state, { verifier, createdAt: Date.now() });

  const params = new URLSearchParams({
    audience: 'api.atlassian.com',
    client_id: ATLASSIAN_CLIENT_ID,
    scope: 'read:jira-work read:jira-user offline_access',
    redirect_uri: CALLBACK_URL,
    state,
    response_type: 'code',
    prompt: 'consent',
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  const authUrl = `${OAUTH_AUTH}?${params.toString()}`;
  console.log('[oauth/login] redirecting to:', authUrl);
  console.log('[oauth/login] CALLBACK_URL:', CALLBACK_URL);
  res.redirect(authUrl);
});


// --- replace your current /auth/callback with this ---
app.get('/auth/callback', async (req, res) => {
  const usedCallback = CALLBACK_URL;
  try {
    const { code, state } = req.query;
    console.log('[oauth/callback] code present:', !!code, 'state:', state);
    console.log('[oauth/callback] CALLBACK_URL used:', usedCallback);

    if (!code || !state) return res.status(400).send('Missing code/state');

    // 1) recover PKCE (cookie + in-memory fallback)
    let pkce;
    try { pkce = JSON.parse(req.cookies?.pkce || '{}'); } catch {}
    clearPkceCookie(res);

    if (!pkce?.verifier || pkce?.state !== state) {
      const mem = pkceMap.get(state);
      if (mem) {
        pkce = { state, verifier: mem.verifier };
        console.log('[oauth/callback] using in-memory PKCE fallback for state', state);
      }
    }
    pkceMap.delete(state);

    if (!pkce?.verifier) {
      console.error('[oauth/callback] PKCE missing after cookie+memory checks');
      return res.status(400).send('Auth session expired. Please try again.');
    }

    // Helper: try token exchange with several variants
    async function tryTokenExchange(variant) {
      const baseFields = {
        grant_type: 'authorization_code',
        client_id: ATLASSIAN_CLIENT_ID,
        code,
        redirect_uri: usedCallback,
        code_verifier: pkce.verifier,
      };
      // If you set a secret in .env, we can include it (some setups require it)
      if (process.env.ATLASSIAN_CLIENT_SECRET && variant.withSecret) {
        baseFields.client_secret = process.env.ATLASSIAN_CLIENT_SECRET;
      }

      let headers, body;
      if (variant.encoding === 'json') {
        headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
        body = JSON.stringify(baseFields);
      } else {
        headers = { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' };
        const sp = new URLSearchParams();
        for (const [k, v] of Object.entries(baseFields)) sp.set(k, v);
        body = sp.toString();
      }

      console.log(`[oauth/callback] EXCHANGE variant=${variant.encoding}${variant.withSecret ? '+secret' : ''}`);
      const r = await fetch(OAUTH_TOKEN, {
        method: 'POST',
        headers,
        body,
      });
      const text = await r.text();

      return { ok: r.ok, status: r.status, text };
    }

    // Try, in order: JSON no secret → URLENC no secret → JSON with secret → URLENC with secret
    const variants = [
      { encoding: 'json',   withSecret: false },
      { encoding: 'urlenc', withSecret: false },
      { encoding: 'json',   withSecret: true  },
      { encoding: 'urlenc', withSecret: true  },
    ];

    let tokenData = null;
    let lastErr = null;
    for (const v of variants) {
      const resp = await tryTokenExchange(v);
      if (resp.ok) {
        try {
          tokenData = JSON.parse(resp.text);
        } catch (e) {
          return res.status(500).send('Token exchange returned non-JSON');
        }
        console.log('[oauth/callback] token exchange success with variant:', v);
        break;
      } else {
        console.error('[oauth/callback] token exchange failed', v, resp.status, resp.text);
        lastErr = resp;
      }
    }

    if (!tokenData) {
      return res
        .status(500)
        .send(`Token exchange failed (${lastErr?.status || 'unknown'}).\nResponse:\n${lastErr?.text || '(no body)'}\n`);
    }

    // Store tokens
    oauth.access_token = tokenData.access_token;
    oauth.refresh_token = tokenData.refresh_token || null;
    oauth.expires_at = Date.now() + (tokenData.expires_in || 3600) * 1000;

    // Discover Jira resources
    console.log('[oauth/callback] GET', OAUTH_RES);
    const resResp = await fetch(OAUTH_RES, { headers: { Authorization: `Bearer ${oauth.access_token}` } });
    const resText = await resResp.text();
    if (!resResp.ok) {
      console.error('[oauth/callback] resources failed', resResp.status, resText);
      return res.status(500).send(`Resources fetch failed (${resResp.status}).\n${resText}`);
    }
    const arr = JSON.parse(resText);
    const jira = (Array.isArray(arr) ? arr : []).find(r => (r.scopes || []).includes('read:jira-work')) || arr[0];
    if (!jira) return res.status(500).send('No Jira resources found');

    oauth.cloud_id = jira.id;
    oauth.account = { name: jira.name || null, url: jira.url || null };
    console.log('[oauth/callback] success; cloud_id:', oauth.cloud_id);

    res.redirect(302, `http://localhost:${PORT}/?auth=ok`);
  } catch (e) {
    console.error('[oauth/callback] error:', e);
    res.status(500).send('Auth callback error: ' + (e?.message || e));
  }
});




app.post('/auth/logout', (req, res) => {
  oauth.access_token = null;
  oauth.refresh_token = null;
  oauth.expires_at = 0;
  oauth.cloud_id = null;
  oauth.account = null;
  res.json({ ok: true });
});

app.get('/auth/status', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    signedIn: !!oauth.access_token,
    cloudId: oauth.cloud_id || null,
    expiresAt: oauth.expires_at || 0,
    account: oauth.account || null,
    hasPATFallback: !!(JIRA_BASE_URL && JIRA_EMAIL && JIRA_API_TOKEN),
  });
});

// ---- MAIN RUN ROUTE ----
// 1) export_jira.py --month <YYYY-MM> --out <tmp/export.csv>
// 2) run_reports_wrapper.py <tmp/export.csv>
// 3) return ZIP with the two CSVs
app.post('/api/run', async (req, res) => {
  try {
    const month = String(req.body?.month || '').trim();
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ ok: false, error: 'Bad month format. Use YYYY-MM.' });
    }

    // Decide auth mode: Prefer OAuth; else PAT; else 401
    const envForPy = { MONTH: month };

    if (oauth.access_token && oauth.cloud_id) {
      // OAuth
      envForPy.OAUTH_ACCESS_TOKEN = oauth.access_token;
      envForPy.CLOUD_ID = oauth.cloud_id;
    } else if (JIRA_BASE_URL && JIRA_EMAIL && JIRA_API_TOKEN) {
      // PAT fallback
      envForPy.JIRA_BASE_URL  = JIRA_BASE_URL;
      envForPy.JIRA_EMAIL     = JIRA_EMAIL;
      envForPy.JIRA_API_TOKEN = JIRA_API_TOKEN;
    } else {
      // No auth available -> fail with clear message
      return res.status(401).json({
        ok: false,
        error: 'No authentication available. Sign in with Atlassian or set JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN in .env.',
      });
    }

    // Pass optional custom-field overrides to Python if present
    if (REOPEN_COUNT_ID)   envForPy.REOPEN_COUNT_ID   = REOPEN_COUNT_ID;
    if (REOPEN_LOG_ID)     envForPy.REOPEN_LOG_ID     = REOPEN_LOG_ID;
    if (REOPEN_COUNT_NAME) envForPy.REOPEN_COUNT_NAME = REOPEN_COUNT_NAME;
    if (REOPEN_LOG_NAME)   envForPy.REOPEN_LOG_NAME   = REOPEN_LOG_NAME;

    // temp dir
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reopen-'));
    const exportPath = path.join(tmpDir, `export_${month}.csv`);

    // 1) export
    await runPy(path.join(__dirname, 'scripts', 'export_jira.py'), ['--month', month, '--out', exportPath], envForPy);

    // 2) reports
    await runPy(path.join(__dirname, 'scripts', 'run_reports_wrapper.py'), [exportPath], envForPy);

    // 3) collect reports (look in root and ./reports, with or without month suffix)
    const reportCandidates = [
      // by user
      {
        paths: [
          path.join(__dirname, `reopens_by_user_${month}.csv`),
          path.join(__dirname, 'reopens_by_user.csv'),
          path.join(__dirname, 'reports', `reopens_by_user_${month}.csv`),
          path.join(__dirname, 'reports', 'reopens_by_user.csv'),
        ],
        zip: `reopens_by_user_${month}.csv`,
      },
      // by ticket
      {
        paths: [
          path.join(__dirname, `reopens_by_ticket_${month}.csv`),
          path.join(__dirname, 'reopens_by_ticket.csv'),
          path.join(__dirname, 'reports', `reopens_by_ticket_${month}.csv`),
          path.join(__dirname, 'reports', 'reopens_by_ticket.csv'),
        ],
        zip: `reopens_by_ticket_${month}.csv`,
      },
    ];

    const zip = new AdmZip();
    let added = 0;

    for (const item of reportCandidates) {
      let found = null;
      for (const p of item.paths) {
        if (fs.existsSync(p)) { found = p; break; }
      }
      if (found) {
        zip.addLocalFile(found, '', item.zip);
        added++;
      }
    }

    if (added !== reportCandidates.length) {
      return res.status(500).json({
        ok: false,
        error:
          'Reports not found after processing. Ensure scripts write reopens_by_user*.csv and reopens_by_ticket*.csv (root or ./reports)',
      });
    }

    const zipPath = path.join(tmpDir, `reopen_reports_${month}.zip`);
    zip.writeZip(zipPath);

    res.download(zipPath, err => {
      // cleanup temp
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      // optional: cleanup generated reports in project root or ./reports
      for (const item of reportCandidates) {
        for (const p of item.paths) {
          try { fs.unlinkSync(p); } catch {}
        }
      }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// === Preview endpoint: returns JSON rows for the selected month ===
app.get('/api/preview', async (req, res) => {
  try {
    const month = String(req.query?.month || '').trim();
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ ok: false, error: 'Bad month format. Use YYYY-MM.' });
    }

    // Choose auth: OAuth if signed-in else PAT fallback else 401
    const envForPy = { MONTH: month };
    if (oauth.access_token && oauth.cloud_id) {
      envForPy.OAUTH_ACCESS_TOKEN = oauth.access_token;
      envForPy.CLOUD_ID = oauth.cloud_id;
      console.log('[preview] using OAuth (cloudId:', oauth.cloud_id, ')');
    } else if (JIRA_BASE_URL && JIRA_EMAIL && JIRA_API_TOKEN) {
      envForPy.JIRA_BASE_URL  = JIRA_BASE_URL;
      envForPy.JIRA_EMAIL     = JIRA_EMAIL;
      envForPy.JIRA_API_TOKEN = JIRA_API_TOKEN;
      console.log('[preview] using PAT fallback for', JIRA_EMAIL, '→', JIRA_BASE_URL);
    } else {
      return res.status(401).json({
        ok: false,
        error: 'No auth available. Sign in with Atlassian or set JIRA_* in .env.',
      });
    }

    // Forward optional custom-field hints, same as /api/run
    if (REOPEN_COUNT_ID)   envForPy.REOPEN_COUNT_ID   = REOPEN_COUNT_ID;
    if (REOPEN_LOG_ID)     envForPy.REOPEN_LOG_ID     = REOPEN_LOG_ID;
    if (REOPEN_COUNT_NAME) envForPy.REOPEN_COUNT_NAME = REOPEN_COUNT_NAME;
    if (REOPEN_LOG_NAME)   envForPy.REOPEN_LOG_NAME   = REOPEN_LOG_NAME;

    // temp dir + export
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reopen-prev-'));
    const exportPath = path.join(tmpDir, `export_${month}.csv`);

    await runPy(path.join(__dirname, 'scripts', 'export_jira.py'), ['--month', month, '--out', exportPath], envForPy);

    // Convert CSV -> JSON via Python (pandas) to avoid adding a Node CSV dep
    const pyOneLiner = [
      'import pandas as pd, sys, json;',
      'df = pd.read_csv(sys.argv[1]);',
      // Normalize headers (strip spaces)
      'df.columns = [c.strip() for c in df.columns];',
      // Rename custom fields to requested labels
      'rename_map = {',
      // handle both exact and slightly different spacing
      '"Custom field (Reopen Count)": "Reopen Count",',
      '"Custom field (Reopen log )": "Reopen Log",',
      '"Custom field (Reopen log)": "Reopen Log",',
      '};',
      'df = df.rename(columns=rename_map);',
      // Select only the columns we need, if present
      'cols = ["Issue key","Issue Type","Issue id","Summary","Assignee","Reopen Count","Reopen Log"];',
      'present = [c for c in cols if c in df.columns];',
      'df = df[present];',
      'print(df.to_json(orient="records"))'
    ].join(' ');

    const { stdout } = await new Promise((resolve, reject) => {
      execFile(PYTHON, ['-c', pyOneLiner, exportPath], { env: { ...process.env } }, (err, out, errout) => {
        if (err) reject(new Error((errout || err.message)));
        else resolve({ stdout: out });
      });
    });

    let rows = [];
    try { rows = JSON.parse(stdout); } catch {
      return res.status(500).json({ ok:false, error:'Failed to parse preview JSON from CSV' });
    }

    // Optional: cap rows for UI responsiveness (remove cap if you want everything)
    // rows = rows.slice(0, 500);

    // Cleanup
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

    return res.json({ ok: true, month, rows });
  } catch (e) {
    console.error('[preview] error', e);
    res.status(500).json({ ok:false, error: e.message });
  }
});

// ---- Serve UI from /public (no build step) ----
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---- Start ----
app.listen(PORT, () => {
  console.log(`Reopen Reports UI running at http://localhost:${PORT}`);
  console.log(`Callback URL: ${CALLBACK_URL}`);
  console.log(`Auth available: OAuth ${ATLASSIAN_CLIENT_ID ? 'ON' : 'OFF'} | PAT ${JIRA_API_TOKEN ? 'ON' : 'OFF'}`);
});
