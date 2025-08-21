#!/usr/bin/env python3
import sys, os, importlib.util
from pathlib import Path

def import_reports():
  mod_path = Path(__file__).resolve().parent / "reports.py"
  if not mod_path.exists():
    print("ERROR: scripts/reports.py not found.", file=sys.stderr); sys.exit(1)
  spec = importlib.util.spec_from_file_location("reports", mod_path)
  mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
  return mod

def main():
  if len(sys.argv) < 2: print("Usage: run_reports_wrapper.py export.csv", file=sys.stderr); sys.exit(2)
  inp = sys.argv[1]
  if not os.path.exists(inp): print(f"Input not found: {inp}", file=sys.stderr); sys.exit(1)
  os.makedirs("reports", exist_ok=True)
  out_user = "reports/reopens_by_user.csv"
  out_ticket = "reports/reopens_by_ticket.csv"
  mod = import_reports()
  if hasattr(mod, "process"): mod.process(inp, out_user, out_ticket)
  elif hasattr(mod, "main"): mod.main(inp, out_user, out_ticket)
  else: print("scripts/reports.py must define process(...) or main(...)", file=sys.stderr); sys.exit(1)
  print(f"✅ Generated:\n  {out_user}\n  {out_ticket}")

if __name__ == "__main__": main()
