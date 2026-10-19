#!/usr/bin/env python3
"""region-scan.py -- the interaction-density instrument for orthogonal regions.

Contract:
  Input:  chart JSON files (each with `id`, `events`, `states`, `guards` keys,
          as produced by tracking-mvp/charts/extract-tables.mjs) plus an
          optional --handoff-pairs file naming declared multi-region events.
  Output: counts + PASS/FAIL per check; exit 0 iff all requested checks pass.
          With --log-decisions, appends one decision event per run (p06).

Checks:
  --overlap  No event is handled by >1 region, except declared handoff pairs.
             (RAT-A1 mechanical; D-Q2 tier-A enforcement target.)
  --guards   No guard expression references another region's state names.
             Lexical scan -- a heuristic oracle, stated as such (qe-ic q03):
             it catches name mentions, not semantic reads.
  --all      Both.

Usage:
  region-scan.py --all charts/*.json [--handoff-pairs pairs.json] [--log-decisions decisions.jsonl]
"""
import json
import os
import sys


def inside_cwd(p):
    """A path from the command line, resolved, and refused unless it is inside the current
    directory: the scan only reads the repo's charts and pairs files, and appends to its own
    log. Exits 2 on a path that escapes (`..`, an absolute path elsewhere, a symlink out)."""
    base = os.path.realpath(os.getcwd())
    full = os.path.realpath(os.path.join(base, p))
    if not full.startswith(base + os.sep):
        print(f"region-scan.py: {p} is outside {base}", file=sys.stderr)
        sys.exit(2)
    return full

def load_charts(paths):
    charts = []
    for p in paths:
        with open(inside_cwd(p)) as f:
            d = json.load(f)
        st = d.get("states", [])
        charts.append({
            "id": d.get("id", p),
            "events": set(d.get("events", [])),
            "states": set(st) if isinstance(st, list) else set(st.keys()),
            "guards": d.get("guards", {}),
            "path": p,
        })
    return charts

def check_overlap(charts, allowed):
    findings = []
    seen = {}
    for c in charts:
        for e in c["events"]:
            seen.setdefault(e, []).append(c["id"])
    for e, regions in sorted(seen.items()):
        if len(regions) > 1 and e not in allowed:
            findings.append(f"event '{e}' handled by regions {regions} (not a declared handoff pair)")
    return findings

def check_guards(charts):
    findings = []
    state_owner = {}
    for c in charts:
        for s in c["states"]:
            state_owner.setdefault(s, []).append(c["id"])
    for c in charts:
        others = {s: o for s, o in state_owner.items() if c["id"] not in o}
        for gname, gexpr in c["guards"].items():
            text = gexpr if isinstance(gexpr, str) else json.dumps(gexpr)
            for s, owners in others.items():
                if s in text:
                    findings.append(
                        f"region '{c['id']}' guard '{gname}' mentions state '{s}' owned by {owners}"
                    )
    return findings

def main():
    args = sys.argv[1:]
    do_overlap = "--overlap" in args or "--all" in args
    do_guards = "--guards" in args or "--all" in args
    if not (do_overlap or do_guards):
        print("usage: region-scan.py (--overlap|--guards|--all) charts/*.json "
              "[--handoff-pairs pairs.json] [--log-decisions decisions.jsonl]")
        sys.exit(2)
    positional = []
    handoff_pairs = set()
    log_path = None
    flag_vals = _flag_values(args)
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--handoff-pairs":
            i += 1
            with open(inside_cwd(args[i])) as f:
                handoff_pairs = set(json.load(f).get("allowed_shared_events", []))
        elif a == "--log-decisions":
            i += 1
            log_path = inside_cwd(args[i])
        elif not a.startswith("--") and a not in flag_vals:
            positional.append(a)
        i += 1
    charts = load_charts(positional)
    all_findings = []
    if do_overlap:
        all_findings += [("overlap", f) for f in check_overlap(charts, handoff_pairs)]
    if do_guards:
        all_findings += [("guards", f) for f in check_guards(charts)]
    regions_n = len(charts)
    events_n = sum(len(c["events"]) for c in charts)
    verdict = "PASS" if not all_findings else "FAIL"
    print(f"{verdict}: {regions_n} regions, {events_n} region-events, "
          f"{len(all_findings)} findings")
    for kind, f in all_findings:
        print(f"  [{kind}] {f}")
    if log_path:
        import datetime
        evt = {
            "event_type": "region_scan.decided",
            "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "actor": "region-scan.py",
            "input": {"charts": [c["path"] for c in charts]},
            "verdict": verdict,
            "findings": [f for _, f in all_findings],
        }
        with open(log_path, "a") as f:
            f.write(json.dumps(evt) + "\n")
    sys.exit(0 if verdict == "PASS" else 1)

def _flag_values(args):
    vals = []
    for i, a in enumerate(args):
        if a in ("--handoff-pairs", "--log-decisions") and i + 1 < len(args):
            vals.append(args[i + 1])
    return vals

if __name__ == "__main__":
    main()
