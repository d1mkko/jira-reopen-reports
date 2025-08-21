import express from 'express';
import { config } from 'dotenv';
import { spawn, spawnSync } from 'child_process';
import { nanoid } from 'nanoid';
import path from 'path';
import fs from 'fs';
import archiver from 'archiver';
import { fileURLToPath } from 'url';

config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Python resolution (prefer python3) ---
function resolvePythonBin() {
  // allow override via env
  if (process.env.PYTHON_BIN) return process.env.PYTHON_BIN;

  // try python3
  const tryBins = [
    'python3',
    'python',
    { cmd: 'py', args: ['-3'] }, // Windows launcher
  ];

  for (const candidate of tryBins) {
    let cmd, args;
    if (typeof candidate === 'string') { cmd = candidate; args = ['-V']; }
    else { cmd = candidate.cmd; args = [...candidate.args, '-V']; }

    try {
      const out = spawnSync(cmd, args, { encoding: 'utf8' });
      const combined = (out.stdout || '') + (out.stderr || '');
      if (out.status === 0 && /Python 3\./.test(combined)) {
        // return exact invocation (for py -3 we return ['py','-3'])
        return typeof candidate === 'string' ? candidate : `${candidate.cmd} ${candidate.args.join(' ')}`;
      }
    } catch {}
  }
  return null;
}

const PY_BIN = resolvePythonBin();

function runPy(script, args = [], env = {}) {
  return new Promise((resolve, reject) => {
    if (!PY_BIN) {
      return reject(new Error(
        'Python 3 not found. Please install Python 3 and ensure "python3" is on your PATH,\n' +
        'or set PYTHON_BIN in your .env (e.g., PYTHON_BIN=/usr/local/bin/python3).'
      ));
    }
    const [cmd, ...prefixArgs] = PY_BIN.split(' ');
    const proc = spawn(cmd, [...prefixArgs, script, ...args], {
      cwd: path.join(__dirname),
      env: { ...process.env, ...env },
    });

    let stdout = '', stderr = '';
    proc.stdout.on('data', d => stdout += d.toString());
    proc.stderr.on('data', d => stderr += d.toString());
    proc.on('close', code => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`python ${path.basename(script)} exited ${code}\n${stderr || stdout}`));
    });
  });
}

// Optional: quick check that required Python libs exist; returns error string if missing
async function checkPythonDeps() {
  try {
    await runPy('-c', ['import sys; assert sys.version_info[0]==3; import requests, pandas']);
    return null;
  } catch (e) {
    return 'Missing Python packages. Please run:\n' +
           '  python3 -m pip install requests pandas\n\n' +
           'Original error:\n' + e.message;
  }
}

app.post('/api/run', async (req, res) => {
  try {
    const month = String(req.body?.month || '').trim();
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ ok: false, error: 'Bad month format. Use YYYY-MM.' });
    }

    const { JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN } = process.env;
    if (!JIRA_BASE_URL || !JIRA_EMAIL || !JIRA_API_TOKEN) {
      return res.status(500).json({ ok: false, error: 'Server missing Jira credentials. Configure .env' });
    }

    // Ensure Python3 + deps
    if (!PY_BIN) {
      return res.status(500).json({ ok: false, error: 'Python 3 not found on PATH. Install Python 3 or set PYTHON_BIN in .env' });
    }
    const depErr = await checkPythonDeps();
    if (depErr) return res.status(500).json({ ok: false, error: depErr });

    const jobId = nanoid(8);
    const tmpDir = path.join(__dirname, '.tmp', jobId);
    fs.mkdirSync(tmpDir, { recursive: true });

    const exportPath = path.join(tmpDir, 'export.csv');

    // 1) export
    await runPy(
      path.join(__dirname, 'scripts', 'export_jira.py'),
      ['--month', month, '--out', exportPath]
    );

    // 2) reports
    await runPy(
      path.join(__dirname, 'scripts', 'run_reports_wrapper.py'),
      [exportPath],
      { MONTH: month }
    );

    const userReport = path.join(__dirname, 'reports', 'reopens_by_user.csv');
    const ticketReport = path.join(__dirname, 'reports', 'reopens_by_ticket.csv');

    // 3) stream ZIP
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="reopen_reports_${month}.zip"`);

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', err => { throw err; });
    archive.pipe(res);
    archive.file(exportPath, { name: `export_${month}.csv` });
    archive.file(userReport, { name: `reopens_by_user_${month}.csv` });
    archive.file(ticketReport, { name: `reopens_by_ticket_${month}.csv` });
    await archive.finalize();

    // cleanup after streaming
    archive.on('end', () => {
      fs.rm(tmpDir, { recursive: true, force: true }, () => {});
      try { fs.unlinkSync(userReport); } catch {}
      try { fs.unlinkSync(ticketReport); } catch {}
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

const port = Number(process.env.PORT || 5173);
app.listen(port, () => {
  console.log(`Reopen Reports UI running at http://localhost:${port}`);
  console.log(`Python binary detected: ${PY_BIN || 'NOT FOUND'}`);
});
