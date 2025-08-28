// server.js (full, month-based export + date-range filtering)
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

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(cookieParser());

// ---------- Config ----------
const PORT   = Number(process.env.PORT || 3000);
const PYTHON = process.env.PYTHON_BIN || 'python3';

// PAT fallback (if user is not signed in with OAuth)
const JIRA_BASE_URL  = process.env.JIRA_BASE_URL || '';
const JIRA_EMAIL     = process.env.JIRA_EMAIL || '';
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN || '';

// Optional custom-field overrides (help scripts resolve IDs)
const REOPEN_COUNT_ID   = process.env.REOPEN_COUNT_ID;
const REOPEN_LOG_ID     = process.env.REOPEN_LOG_ID;
const REOPEN_COUNT_NAME = process.env.REOPEN_COUNT_NAME;
const REOPEN_LOG_NAME   = process.env.REOPEN_LOG_NAME;

// OAuth (3LO PKCE)
const ATLASSIAN_CLIENT_ID     = process.env.ATLASSIAN_CLIENT_ID || '';
const ATLASSIAN_CLIENT_SECRET = process.env.ATLASSIAN_CLIENT_SECRET || '';
const CALLBACK_URL = process.env.ATLASSIAN_CALLBACK_URL || `http://localhost:${PORT}/auth/callback`;
const OAUTH_AUTH  = 'https://auth.atlassian.com/authorize';
const OAUTH_TOKEN = 'https://auth.atlassian.com/oauth/token';
const OAUTH_RES   = 'https://api.atlassian.com/oauth/token/accessible-resources';

// In-memory oauth (single-user local dev)
const oauth = {
  access_token: null,
  refresh_token: null,
  expires_at: 0,
  cloud_id: null,
  account: null,
};

// ===== Utils =====
function b64url(buf) { return buf.toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
function genVerifier() { return b64url(crypto.randomBytes(32)); }
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest(); }
function clearPkceCookie(res) { res.clearCookie('pkce', { path: '/' }); }
function setPkceCookie(res, data) {
  res.cookie('pkce', JSON.stringify(data), { httpOnly:true, sameSite:'Lax', secure:false, maxAge:5*60*1000, path:'/' });
}

// Run python file
function runPy(file, args = [], extraEnv = {}) {
  return new Promise((resolve, reject) => {
    execFile(PYTHON, [file, ...args], { env: { ...process.env, ...extraEnv } }, (err, stdout, stderr) => {
      if (err) {
        const tail = (stderr || stdout || '').toString().split('\n').slice(-30).join('\n');
        return reject(new Error(`${path.basename(file)} failed:\n${tail}`));
      }
      resolve({ stdout, stderr });
    });
  });
}

// ---- List months between two dates (inclusive) as 'YYYY-MM'
function monthsBetweenInclusive(fromISO, toISO) {
  const out = [];
  const from = new Date(fromISO + 'T00:00:00');
  const to   = new Date(toISO   + 'T00:00:00');
  if (from > to) return out;
  let y = from.getFullYear(), m = from.getMonth();
  const yEnd = to.getFullYear(), mEnd = to.getMonth();
  while (y < yEnd || (y === yEnd && m <= mEnd)) {
    out.push(`${y}-${String(m+1).padStart(2,'0')}`);
    m += 1;
    if (m > 11) { m = 0; y += 1; }
  }
  return out;
}

// ---- Export multiple months into ONE CSV ----
// Uses your export_jira.py --month <YYYY-MM> --out <file>, then concatenates.
async function exportRangeToCsv({ fromISO, toISO, outPath, envForPy, tmpDir }) {
  const months = monthsBetweenInclusive(fromISO, toISO);
  if (!months.length) {
    fs.writeFileSync(outPath, '');
    return;
  }
  let wroteHeader = false;
  const chunks = [];

  for (const mm of months) {
    const tmpFile = path.join(tmpDir, `export_${mm}.csv`);
    await runPy(path.join(__dirname, 'scripts', 'export_jira.py'), ['--month', mm, '--out', tmpFile], envForPy);

    const csv = fs.readFileSync(tmpFile, 'utf8');
    if (!csv.trim()) continue;
    const lines = csv.split('\n');

    if (!wroteHeader) {
      chunks.push(csv.trimEnd());
      wroteHeader = true;
    } else {
      // skip header line on subsequent months
      const body = lines.slice(1).join('\n').trim();
      if (body) chunks.push(body);
    }
  }

  fs.writeFileSync(outPath, chunks.join('\n') + (chunks.length ? '\n' : ''));
}

// ---- Filter exported CSV to only reopen log lines in a date range (inclusive) ----
// mode=json -> prints JSON records; mode=csv -> writes to outPath
async function filterReopenByRange({ python, inPath, fromISO, toISO, mode = 'json', outPath }) {
  const py = [
    'import pandas as pd, sys, re, json;',
    'inp, start, end, mode = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4];',
    'outp = sys.argv[5] if len(sys.argv)>5 else None;',
    'df = pd.read_csv(inp);',
    'df.columns = [c.strip() for c in df.columns];',
    'log_col = None',
    'for name in ["Reopen Log","Custom field (Reopen log )","Custom field (Reopen log)"]:',
    '    if name in df.columns: log_col = name; break',
    'cnt_col = None',
    'if "Reopen Count" in df.columns: cnt_col = "Reopen Count"',
    'elif "Custom field (Reopen Count)" in df.columns: cnt_col = "Custom field (Reopen Count)"',
    'if log_col is None:',
    '    if mode=="json": print("[]");',
    '    else: pd.DataFrame([]).to_csv(outp, index=False);',
    '    sys.exit(0)',
    'S = start; E = end',
    'def keep_range_lines(txt):',
    '    if not isinstance(txt, str): return 0, ""',
    '    parts = re.split(r"(?=\\d{4}-\\d{2}-\\d{2})", txt)',
    '    kept = []',
    '    for p in parts:',
    '        t = p.strip()',
    '        if len(t)>=10 and t[:10] >= S and t[:10] <= E:',
    '            kept.append(t)',
    '    return len(kept), "\\n".join(kept)',
    'counts=[]; newlog=[]',
    'for v in df[log_col].fillna(""):',
    '    c, j = keep_range_lines(v)',
    '    counts.append(c); newlog.append(j)',
    'df["__c"]=counts; df[log_col]=newlog',
    'df["Reopen Count"]=df["__c"]',
    'if cnt_col is not None: df[cnt_col]=df["__c"]',
    'df = df[df["__c"]>0].drop(columns=["__c"])',
    'if mode=="json":',
    '    cols=["Issue key","Issue Type","Issue id","Summary","Assignee","Reopen Count", log_col]',
    '    present=[c for c in cols if c in df.columns]',
    '    print(df[present].rename(columns={log_col:"Reopen Log"}).to_json(orient="records"))',
    'else:',
    '    df.to_csv(outp, index=False)',
  ].join('\n');

  return await new Promise((resolve, reject) => {
    const args = ['-c', py, inPath, fromISO, toISO, mode];
    if (mode === 'csv') args.push(outPath);
    execFile(PYTHON, args, { env: { ...process.env } }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve({ stdout });
    });
  });
}

// ---- Filter CSV by teams (prefix of Issue key) ----
async function filterCsvByTeams({ python, inPath, outPath, teams = [] }) {
  const py = [
    'import pandas as pd, sys, json;',
    'inp, outp, teams_json = sys.argv[1], sys.argv[2], sys.argv[3];',
    'teams = json.loads(teams_json) if teams_json else [];',
    'df = pd.read_csv(inp);',
    'if teams:',
    '    if "Issue key" in df.columns:',
    '        proj = df["Issue key"].astype(str).str.split("-").str[0];',
    '        df = df[proj.isin(teams)];',
    'df.to_csv(outp, index=False);'
  ].join(' ');
  return await new Promise((resolve, reject) => {
    const args = ['-c', py, inPath, outPath, JSON.stringify(teams)];
    execFile(PYTHON, args, { env: { ...process.env } }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve();
    });
  });
}

// ---------- AUTH ----------
app.get('/auth/login', (req, res) => {
  if (!ATLASSIAN_CLIENT_ID) return res.status(500).send('Missing ATLASSIAN_CLIENT_ID');
  const state = nanoid(16);
  const verifier = genVerifier();
  const challenge = b64url(sha256(Buffer.from(verifier)));
  setPkceCookie(res, { state, verifier, createdAt: Date.now() });

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
  res.redirect(`${OAUTH_AUTH}?${params.toString()}`);
});

app.get('/auth/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) return res.status(400).send('Missing code/state');

    let pkce = {};
    try { pkce = JSON.parse(req.cookies?.pkce || '{}'); } catch {}
    clearPkceCookie(res);
    if (!pkce?.verifier || pkce?.state !== state) {
      return res.status(400).send('Auth session expired. Try again.');
    }

    const payload = {
      grant_type: 'authorization_code',
      client_id: ATLASSIAN_CLIENT_ID,
      code,
      redirect_uri: CALLBACK_URL,
      code_verifier: pkce.verifier,
      ...(ATLASSIAN_CLIENT_SECRET ? { client_secret: ATLASSIAN_CLIENT_SECRET } : {})
    };

    const r = await fetch(OAUTH_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(payload)
    });
    const t = await r.json();
    if (!r.ok) {
      return res.status(500).send(`Token exchange failed (${r.status}): ${JSON.stringify(t)}`);
    }

    oauth.access_token = t.access_token;
    oauth.refresh_token = t.refresh_token || null;
    oauth.expires_at = Date.now() + (t.expires_in || 3600) * 1000;

    const rr = await fetch(OAUTH_RES, { headers: { Authorization: `Bearer ${oauth.access_token}` }});
    const arr = await rr.json();
    if (!Array.isArray(arr) || !arr.length) return res.status(500).send('No Jira resources');
    const jira = arr.find(x => (x.scopes || []).includes('read:jira-work')) || arr[0];
    oauth.cloud_id = jira.id;
    oauth.account = { name: jira.name, url: jira.url };

    res.redirect(`/?auth=ok`);
  } catch (e) {
    res.status(500).send('Auth error: ' + (e?.message || e));
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

// ---------- API: PREVIEW ----------
app.get('/api/preview', async (req, res) => {
  try {
    const from = String(req.query.from || '').trim();
    const to   = String(req.query.to   || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) {
      return res.status(400).json({ ok:false, error:'Bad date range. Use YYYY-MM-DD and ensure from <= to.' });
    }

    const teamsParam = String(req.query.teams || '').trim();
    const teams = teamsParam ? teamsParam.split(',').map(s => s.trim()).filter(Boolean) : [];

    const envForPy = {};
    if (oauth.access_token && oauth.cloud_id) {
      envForPy.OAUTH_ACCESS_TOKEN = oauth.access_token;
      envForPy.CLOUD_ID = oauth.cloud_id;
    } else if (JIRA_BASE_URL && JIRA_EMAIL && JIRA_API_TOKEN) {
      envForPy.JIRA_BASE_URL  = JIRA_BASE_URL;
      envForPy.JIRA_EMAIL     = JIRA_EMAIL;
      envForPy.JIRA_API_TOKEN = JIRA_API_TOKEN;
    } else {
      return res.status(401).json({ ok:false, error:'No auth available. Sign in with Atlassian or set JIRA_* in .env.' });
    }
    if (REOPEN_COUNT_ID)   envForPy.REOPEN_COUNT_ID   = REOPEN_COUNT_ID;
    if (REOPEN_LOG_ID)     envForPy.REOPEN_LOG_ID     = REOPEN_LOG_ID;
    if (REOPEN_COUNT_NAME) envForPy.REOPEN_COUNT_NAME = REOPEN_COUNT_NAME;
    if (REOPEN_LOG_NAME)   envForPy.REOPEN_LOG_NAME   = REOPEN_LOG_NAME;

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reopen-prev-'));
    const exportPath = path.join(tmpDir, `export_${from}_${to}.csv`);

    // Export all months in range into one CSV
    await exportRangeToCsv({ fromISO: from, toISO: to, outPath: exportPath, envForPy, tmpDir });

    // Filter by date range → JSON
    const { stdout } = await filterReopenByRange({
      python: PYTHON, inPath: exportPath, fromISO: from, toISO: to, mode: 'json'
    });

    let rows = [];
    try { rows = JSON.parse(stdout || '[]'); } catch { rows = []; }

    // Team filter on server
    if (teams.length) {
      rows = rows.filter(r => teams.includes(String(r['Issue key'] || '').split('-')[0] || ''));
    }

    const allTeams = Array.from(new Set(rows.map(r => String(r['Issue key'] || '').split('-')[0]).filter(Boolean))).sort();

    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    res.json({ ok:true, rows, teams: allTeams });
  } catch (e) {
    console.error('[preview] error', e);
    res.status(500).json({ ok:false, error: e.message });
  }
});

// ---------- API: RUN (download) ----------
app.post('/api/run', async (req, res) => {
  try {
    const from = String(req.body?.from || '').trim();
    const to   = String(req.body?.to   || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) {
      return res.status(400).json({ ok:false, error:'Bad date range. Use YYYY-MM-DD and ensure from <= to.' });
    }
    const teams = Array.isArray(req.body?.teams) ? req.body.teams.filter(Boolean) : [];

    const envForPy = {};
    if (oauth.access_token && oauth.cloud_id) {
      envForPy.OAUTH_ACCESS_TOKEN = oauth.access_token;
      envForPy.CLOUD_ID = oauth.cloud_id;
    } else if (JIRA_BASE_URL && JIRA_EMAIL && JIRA_API_TOKEN) {
      envForPy.JIRA_BASE_URL  = JIRA_BASE_URL;
      envForPy.JIRA_EMAIL     = JIRA_EMAIL;
      envForPy.JIRA_API_TOKEN = JIRA_API_TOKEN;
    } else {
      return res.status(401).json({ ok:false, error:'No authentication available. Sign in with Atlassian or set JIRA_* in .env.' });
    }
    if (REOPEN_COUNT_ID)   envForPy.REOPEN_COUNT_ID   = REOPEN_COUNT_ID;
    if (REOPEN_LOG_ID)     envForPy.REOPEN_LOG_ID     = REOPEN_LOG_ID;
    if (REOPEN_COUNT_NAME) envForPy.REOPEN_COUNT_NAME = REOPEN_COUNT_NAME;
    if (REOPEN_LOG_NAME)   envForPy.REOPEN_LOG_NAME   = REOPEN_LOG_NAME;

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reopen-run-'));
    const exportPath = path.join(tmpDir, 'export.csv');

    // Export all months in range into one CSV
    await exportRangeToCsv({ fromISO: from, toISO: to, outPath: exportPath, envForPy, tmpDir });

    // Filter by range → CSV for reporting
    const filteredPath = path.join(tmpDir, 'export_filtered.csv');
    await filterReopenByRange({
      python: PYTHON, inPath: exportPath, fromISO: from, toISO: to, mode: 'csv', outPath: filteredPath
    });

    // Optional team filter
    let inputForReports = filteredPath;
    if (teams.length) {
      const teamFilteredPath = path.join(tmpDir, 'export_filtered_teams.csv');
      await filterCsvByTeams({ python: PYTHON, inPath: filteredPath, outPath: teamFilteredPath, teams });
      inputForReports = teamFilteredPath;
    }

    // Run report script
    await runPy(path.join(__dirname, 'scripts', 'run_reports_wrapper.py'), [inputForReports], envForPy);

    // Find produced CSVs
    const reportsDir = path.join(__dirname, 'reports');
    const userCsvCandidates = [
      path.join(reportsDir, `reopens_by_user_${from}_to_${to}.csv`),
      path.join(reportsDir, `reopens_by_user_${from}-${to}.csv`),
      path.join(reportsDir, 'reopens_by_user.csv'),
    ];
    const ticketCsvCandidates = [
      path.join(reportsDir, `reopens_by_ticket_${from}_to_${to}.csv`),
      path.join(reportsDir, `reopens_by_ticket_${from}-${to}.csv`),
      path.join(reportsDir, 'reopens_by_ticket.csv'),
    ];
    const userCsv   = userCsvCandidates.find(p => fs.existsSync(p));
    const ticketCsv = ticketCsvCandidates.find(p => fs.existsSync(p));
    if (!userCsv || !ticketCsv) throw new Error('Reports not found. Ensure wrapper writes the two CSVs');

    // Create ZIP
    const zip = new AdmZip();
    zip.addLocalFile(userCsv,   '', path.basename(userCsv));
    zip.addLocalFile(ticketCsv, '', path.basename(ticketCsv));
    const buf = zip.toBuffer();
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="reopen_reports_${from}_to_${to}.zip"`);
    res.setHeader('Content-Length', String(buf.length));
    res.status(200).send(buf);

    // Cleanup
    try { fs.rmSync(tmpDir, { recursive:true, force:true }); } catch {}
  } catch (e) {
    console.error('[run] error', e);
    res.status(500).json({ ok:false, error: `Report generation failed: ${e.message}` });
  }
});

// ---------- Static UI ----------
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`Reopen Reports UI running at http://localhost:${PORT}`);
  console.log(`Callback URL: ${CALLBACK_URL}`);
  console.log(`Auth: OAuth ${ATLASSIAN_CLIENT_ID ? 'ON' : 'OFF'} | PAT ${JIRA_API_TOKEN ? 'ON' : 'OFF'}`);
});
