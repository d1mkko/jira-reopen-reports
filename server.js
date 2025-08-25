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

// Filters export CSV by month, keeping ONLY Reopen Log lines that start with YYYY-MM of that month.
// Rewrites "Reopen Log" and "Reopen Count" accordingly.
// mode = "json" → returns JSON via stdout (for /api/preview)
// mode = "csv"  → writes filtered CSV to outPath (for /api/run)
async function filterReopenByMonth({ python, month, inPath, mode = 'json', outPath }) {
  const py = [
    'import pandas as pd, sys, re',
    'month, inp, mode = sys.argv[1], sys.argv[2], sys.argv[3]',
    'outp = sys.argv[4] if len(sys.argv)>4 else None',
    '',
    'df = pd.read_csv(inp)',
    'df.columns = [c.strip() for c in df.columns]',
    '',
    '# find log/count columns under possible display names',
    'log_col = None',
    'for name in ["Reopen Log","Custom field (Reopen log )","Custom field (Reopen log)"]:',
    '    if name in df.columns:',
    '        log_col = name',
    '        break',
    '',
    'cnt_col = None',
    'if "Reopen Count" in df.columns:',
    '    cnt_col = "Reopen Count"',
    'elif "Custom field (Reopen Count)" in df.columns:',
    '    cnt_col = "Custom field (Reopen Count)"',
    '',
    'if log_col is None:',
    '    # No log column → return empty set so UI shows nothing for this month',
    '    if mode=="json":',
    '        print("[]")',
    '    else:',
    '        pd.DataFrame([]).to_csv(outp, index=False)',
    '    sys.exit(0)',
    '',
    'def keep_month_lines(txt):',
    '    if not isinstance(txt, str):',
    '        return 0, ""',
    '    parts = re.split(r\'(?=\\d{4}-\\d{2}-\\d{2})\', txt)',
    '    kept = [p.strip() for p in parts if p.strip().startswith(month)]',
    '    return len(kept), "\\n".join(kept)',
    '',
    'counts = []',
    'newlog = []',
    'for val in df[log_col].fillna(""):',
    '    c, j = keep_month_lines(val)',
    '    counts.append(c)',
    '    newlog.append(j)',
    '',
    'df["__c"] = counts',
    'df[log_col] = newlog',
    'if cnt_col is not None:',
    '    df[cnt_col] = df["__c"]',
    'df = df[df["__c"] > 0].drop(columns=["__c"])',
    '',
    'if mode == "json":',
    '    cols = ["Issue key","Issue Type","Issue id","Summary","Assignee","Reopen Count", log_col]',
    '    present = [c for c in cols if c in df.columns]',
    '    print(df[present].rename(columns={log_col:"Reopen Log"}).to_json(orient="records"))',
    'else:',
    '    df.to_csv(outp, index=False)',
  ].join('\n');

  return await new Promise((resolve, reject) => {
    const args = ['-c', py, month, inPath, mode];
    if (mode === 'csv') args.push(outPath);
    execFile(python, args, { env: { ...process.env } }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve({ stdout });
    });
  });
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
      return res.status(400).json({ ok:false, error:'Bad month format. Use YYYY-MM.' });
    }

    // Auth: OAuth first, else PAT fallback, else 401
    const envForPy = { MONTH: month };
    if (oauth.access_token && oauth.cloud_id) {
      envForPy.OAUTH_ACCESS_TOKEN = oauth.access_token;
      envForPy.CLOUD_ID = oauth.cloud_id;
      console.log('[run] using OAuth (cloudId:', oauth.cloud_id, ')');
    } else if (JIRA_BASE_URL && JIRA_EMAIL && JIRA_API_TOKEN) {
      envForPy.JIRA_BASE_URL  = JIRA_BASE_URL;
      envForPy.JIRA_EMAIL     = JIRA_EMAIL;
      envForPy.JIRA_API_TOKEN = JIRA_API_TOKEN;
      console.log('[run] using PAT fallback for', JIRA_EMAIL, '→', JIRA_BASE_URL);
    } else {
      return res.status(401).json({ ok:false, error:'No authentication available. Sign in with Atlassian or set JIRA_* in .env.' });
    }

    // Optional custom-field overrides
    if (REOPEN_COUNT_ID)   envForPy.REOPEN_COUNT_ID   = REOPEN_COUNT_ID;
    if (REOPEN_LOG_ID)     envForPy.REOPEN_LOG_ID     = REOPEN_LOG_ID;
    if (REOPEN_COUNT_NAME) envForPy.REOPEN_COUNT_NAME = REOPEN_COUNT_NAME;
    if (REOPEN_LOG_NAME)   envForPy.REOPEN_LOG_NAME   = REOPEN_LOG_NAME;

    // 1) Export raw CSV
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reopen-run-'));
    const exportPath = path.join(tmpDir, 'export.csv');
    await runPy(path.join(__dirname, 'scripts', 'export_jira.py'), ['--month', month, '--out', exportPath], envForPy);

    // 2) Filter by month → write filtered CSV (this is what reports will use)
    const filteredPath = path.join(tmpDir, 'export_filtered.csv');
    await filterReopenByMonth({
      python: PYTHON,
      month,
      inPath: exportPath,
      mode: 'csv',
      outPath: filteredPath,
    });

    // 3) Run your reports script against the FILTERED export
    //    (adjust args if your wrapper expects positional names differently)
    await runPy(path.join(__dirname, 'scripts', 'run_reports_wrapper.py'), [filteredPath], envForPy);

    // 4) Find produced report files (try with month suffix first, then fallback)
    const reportsDir = path.join(__dirname, 'reports');
    const userCsvCandidates = [
      path.join(reportsDir, `reopens_by_user_${month}.csv`),
      path.join(reportsDir, 'reopens_by_user.csv'),
    ];
    const ticketCsvCandidates = [
      path.join(reportsDir, `reopens_by_ticket_${month}.csv`),
      path.join(reportsDir, 'reopens_by_ticket.csv'),
    ];
    const userCsv   = userCsvCandidates.find(p => fs.existsSync(p));
    const ticketCsv = ticketCsvCandidates.find(p => fs.existsSync(p));

    if (!userCsv || !ticketCsv) {
      throw new Error('Reports not found after processing. Ensure scripts write reopens_by_user*.csv and reopens_by_ticket*.csv');
    }

    // 5) Package ZIP for download
    const zip = new AdmZip();
    zip.addLocalFile(userCsv, '', path.basename(userCsv));
    zip.addLocalFile(ticketCsv, '', path.basename(ticketCsv));

    const zipBuffer = zip.toBuffer();
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="reopen_reports_${month}.zip"`);
    res.setHeader('Content-Length', String(zipBuffer.length));
    res.status(200).send(zipBuffer);

    // 6) Cleanup
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  } catch (e) {
    console.error('[run] error', e);
    res.status(500).json({ ok:false, error: `Report generation failed: ${e.message}` });
  }
});


// === Preview endpoint: returns JSON rows for the selected month ===
app.get('/api/preview', async (req, res) => {
  try {
    const month = String(req.query?.month || '').trim();
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ ok: false, error: 'Bad month format. Use YYYY-MM.' });
    }

    // Auth: OAuth first, else PAT fallback, else 401
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

    // Optional custom-field overrides
    if (REOPEN_COUNT_ID)   envForPy.REOPEN_COUNT_ID   = REOPEN_COUNT_ID;
    if (REOPEN_LOG_ID)     envForPy.REOPEN_LOG_ID     = REOPEN_LOG_ID;
    if (REOPEN_COUNT_NAME) envForPy.REOPEN_COUNT_NAME = REOPEN_COUNT_NAME;
    if (REOPEN_LOG_NAME)   envForPy.REOPEN_LOG_NAME   = REOPEN_LOG_NAME;

    // Export raw CSV for the month
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reopen-prev-'));
    const exportPath = path.join(tmpDir, `export_${month}.csv`);
    await runPy(path.join(__dirname, 'scripts', 'export_jira.py'), ['--month', month, '--out', exportPath], envForPy);

    // Filter to ONLY logs within the selected month and recompute counts (JSON out)
    const { stdout } = await filterReopenByMonth({
      python: PYTHON,
      month,
      inPath: exportPath,
      mode: 'json',
    });

    let rows = [];
    try { rows = JSON.parse(stdout || '[]'); } catch { rows = []; }

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
