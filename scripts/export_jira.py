#!/usr/bin/env python3
import os, sys, csv, argparse, base64, calendar, requests

HEADERS = [
    "Issue key","Issue Type","Issue id","Summary","Assignee","Assignee Id",
    "Custom field (Reopen Count)","Custom field (Reopen log )",
]
DEFAULT_REOPEN_COUNT_NAME = "Reopen Count"
DEFAULT_REOPEN_LOG_NAME   = "Reopen log"

def month_to_range(month: str):
    import re
    if not re.match(r"^\d{4}-\d{2}$", month or ""):
        print("Bad month format. Use YYYY-MM", file=sys.stderr); sys.exit(2)
    y, m = map(int, month.split("-"))
    last = calendar.monthrange(y, m)[1]
    return f"{y:04d}-{m:02d}-01", f"{y:04d}-{m:02d}-{last:02d}"

def _auth_headers_basic(email, token):
    b64 = "Basic " + base64.b64encode(f"{email}:{token}".encode()).decode()
    return {"Accept":"application/json","Content-Type":"application/json","Authorization":b64}

def _auth_headers_bearer(at):
    return {"Accept":"application/json","Content-Type":"application/json","Authorization":f"Bearer {at}"}

def _base_and_headers():
    """
    Returns (base, headers, mode) where:
      - OAuth: base='https://api.atlassian.com/ex/jira/{cloudId}', headers=Bearer
      - PAT:   base='<JIRA_BASE_URL>', headers=Basic
    """
    at = os.environ.get("OAUTH_ACCESS_TOKEN")
    cloud = os.environ.get("CLOUD_ID")
    if at and cloud:
        return f"https://api.atlassian.com/ex/jira/{cloud}", _auth_headers_bearer(at), "oauth"
    # fallback PAT
    base = os.environ.get("JIRA_BASE_URL","").rstrip("/")
    email = os.environ.get("JIRA_EMAIL","")
    token = os.environ.get("JIRA_API_TOKEN","")
    if not base or not email or not token:
        print("Missing OAuth (OAUTH_ACCESS_TOKEN/CLOUD_ID) and PAT fallback (JIRA_BASE_URL/JIRA_EMAIL/JIRA_API_TOKEN).", file=sys.stderr)
        sys.exit(1)
    return base, _auth_headers_basic(email, token), "pat"

def fetch_all_fields(base, headers):
    url = f"{base}/rest/api/3/field"
    r = requests.get(url, headers=headers, timeout=60)
    if not r.ok:
        print(f"Failed to read fields: {r.status_code} {r.text[:300]}", file=sys.stderr); sys.exit(1)
    return r.json()

def build_field_indexes(fields):
    by_name={}
    for f in fields:
        name=(f.get("name") or "").strip().lower()
        fid=f.get("id")
        if name and fid: by_name.setdefault(name, []).append(f)
    return by_name

def normalize_name(s: str):
    s=(s or "").strip().lower()
    return s.split("[",1)[0].strip() if "[" in s else s

def resolve_cf_id(display, by_name):
    norm=normalize_name(display)
    if norm in by_name: return by_name[norm][0]["id"], f"resolved by exact name: '{display}'"
    for k,lst in by_name.items():
        kk = normalize_name(k)
        if kk==norm or k.startswith(norm) or (norm and norm in k):
            return lst[0]["id"], f"resolved by fuzzy: '{display}' -> '{k}'"
    return None, f"not found for '{display}'"

def iter_issues_search_jql(base, headers, jql, fields, path):
    url=f"{base}{path}"
    next_token=None
    while True:
        body={"jql": jql, "maxResults": 100, "fields": fields}
        if next_token: body["nextPageToken"]=next_token
        r=requests.post(url, json=body, headers=headers, timeout=90)
        if not r.ok: raise RuntimeError(f"{path} {r.status_code} {r.text[:300]}")
        data=r.json() or {}
        for it in data.get("issues", []): yield it
        if data.get("isLast", True): break
        next_token=data.get("nextPageToken")
        if not next_token: break

def search_jql_with_fallback(base, headers, jql, fields):
    for path in ("/rest/api/3/search/jql", "/rest/api/3/jql/search"):
        print(f"[export] trying {path}")
        try:
            for issue in iter_issues_search_jql(base, headers, jql, fields, path):
                yield issue
            print(f"[export] search OK via {path}")
            return
        except RuntimeError as e:
            print(f"[export] {path} failed; {e}")
    print("Jira search failed on both /search/jql and /jql/search.", file=sys.stderr); sys.exit(1)

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--month", required=True); ap.add_argument("--out", default="export.csv")
    args=ap.parse_args()

    start,end = month_to_range(args.month)
    jql = f'status CHANGED TO "Reopen" DURING ("{start}", "{end}") AND "Reopen log [Short text]" IS NOT EMPTY'

    base, headers, mode = _base_and_headers()
    print(f"[export] mode: {mode} base: {base}")

    fields_json = fetch_all_fields(base, headers)
    by_name = build_field_indexes(fields_json)
    cf_count, info1 = resolve_cf_id(DEFAULT_REOPEN_COUNT_NAME, by_name)
    cf_log,   info2 = resolve_cf_id(DEFAULT_REOPEN_LOG_NAME, by_name)
    print(f"[export] Reopen Count resolution: {info1}")
    print(f"[export] Reopen Log   resolution: {info2}")
    if not cf_count or not cf_log:
        print("ERROR: Could not resolve custom field IDs.", file=sys.stderr); sys.exit(1)

    fields=["issuetype","key","id","summary","assignee", cf_count, cf_log]

    rows=[]
    for issue in search_jql_with_fallback(base, headers, jql, fields):
        f=issue.get("fields") or {}
        iss_type=(f.get("issuetype") or {}).get("name","") or ""
        ass=f.get("assignee") or {}
        reopen_log_val = f.get(cf_log)
        if reopen_log_val is None: reopen_log_val = ""
        elif isinstance(reopen_log_val, list): reopen_log_val = "; ".join(map(str, reopen_log_val))

        rows.append([
            issue.get("key",""),
            iss_type,
            issue.get("id",""),
            f.get("summary","") or "",
            ass.get("displayName","") or "",
            ass.get("accountId","") or "",
            "" if f.get(cf_count) is None else f.get(cf_count),
            reopen_log_val,
        ])

    with open(args.out,"w",newline="",encoding="utf-8") as fp:
        w=csv.writer(fp); w.writerow(HEADERS); w.writerows(rows)
    print(f"Wrote {args.out} with {len(rows)} rows for {args.month}")

if __name__=="__main__": main()
