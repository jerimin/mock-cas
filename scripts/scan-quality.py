"""Pre-scan the bank for duplicates and consistency issues.

Surfaces:
  1. Near-duplicate stems (token Jaccard >= threshold) — beyond exact dups
  2. Near-duplicate full questions (stem + option-set overlap)
  3. Proper-noun casing variants (vMotion vs VMotion, CVK vs cvk, etc.)
  4. Option-internal issues (leading-letter prefixes like "A." baked into option text)
  5. correctIndices distribution skew per format
  6. Explanation style outliers (too short, missing terminal punctuation)
  7. Whitespace / punctuation artifacts
Read-only. Writes a JSON report to build/quality-report.json.
"""
import json, re, os
from itertools import combinations
from collections import defaultdict, Counter

PATH = "public/assets/data/bank.json"
with open(PATH, encoding="utf-8") as fp:
    bank = json.load(fp)

STOP = set("a an the of to in on for and or is are be as by with at from this that which following correct incorrect statements statement about regarding among descriptions option options".split())

def tokens(s):
    return [w for w in re.findall(r"[a-z0-9]+", s.lower()) if w not in STOP and len(w) > 2]

def jaccard(a, b):
    sa, sb = set(a), set(b)
    if not sa or not sb:
        return 0.0
    return len(sa & sb) / len(sa | sb)

report = {"near_dup_stems": [], "near_dup_full": [], "casing": {}, "option_prefix": [],
          "ci_distribution": {}, "explanation_outliers": [], "whitespace": []}

# 1 + 2: near-duplicate stems & full questions
stem_tokens = [(q["id"], q["section"], tokens(q["question"]), q) for q in bank]
for (id1, s1, t1, q1), (id2, s2, t2, q2) in combinations(stem_tokens, 2):
    js = jaccard(t1, t2)
    if js >= 0.70:
        # also compare option sets
        opt1 = set(o.lower().strip() for o in q1.get("options", []))
        opt2 = set(o.lower().strip() for o in q2.get("options", []))
        opt_overlap = len(opt1 & opt2) / max(1, min(len(opt1), len(opt2)))
        entry = {"a": id1, "b": id2, "stem_jaccard": round(js, 2),
                 "opt_overlap": round(opt_overlap, 2),
                 "qa": q1["question"][:90], "qb": q2["question"][:90],
                 "same_section": s1 == s2}
        if js >= 0.85 or opt_overlap >= 0.5:
            report["near_dup_full"].append(entry)
        else:
            report["near_dup_stems"].append(entry)

# 3: proper-noun casing variants
TERMS = ["vmotion", "cvk", "cvm", "ovs", "iscsi", "vxlan", "nvgre", "sr-iov", "raid",
         "drs", "dpm", "ocfs2", "qcow2", "iqn", "fbwc", "bbwc", "lun", "wwn", "vlan",
         "irf", "mdc", "iaas", "paas", "saas", "h3c", "cas", "uis", "onestor", "srm",
         "vgpu", "numa", "cbt", "ha", "ft", "snmp", "ntp", "dhcp", "tcp", "udp"]
casing = defaultdict(Counter)
for q in bank:
    text = " ".join([q["question"]] + q.get("options", []) + [q.get("explanation", "")])
    for term in TERMS:
        for m in re.finditer(r"\b" + re.escape(term) + r"\b", text, re.I):
            casing[term][m.group(0)] += 1
for term, variants in casing.items():
    if len(variants) > 1:
        report["casing"][term] = dict(variants)

# 4: option text with baked-in letter prefix ("A." / "A)" / "A -")
for q in bank:
    for i, o in enumerate(q.get("options", [])):
        if re.match(r"^\s*[A-Ea-e][.)\-]\s", o):
            report["option_prefix"].append({"id": q["id"], "opt": i, "text": o[:50]})

# 5: correctIndices position distribution per format
ci_by_fmt = defaultdict(Counter)
for q in bank:
    for ci in q.get("correctIndices", []):
        ci_by_fmt[q["format"]][ci] += 1
report["ci_distribution"] = {f: dict(sorted(c.items())) for f, c in ci_by_fmt.items()}

# 6: explanation outliers
for q in bank:
    e = q.get("explanation", "")
    issues = []
    if len(e.strip()) < 40:
        issues.append(f"short({len(e.strip())})")
    if e and not e.strip().endswith((".", "!", "?")):
        issues.append("no-terminal-punct")
    if issues:
        report["explanation_outliers"].append({"id": q["id"], "issues": issues, "text": e[:60]})

# 7: whitespace / punctuation artifacts
ARTIFACT = re.compile(r"  |\s,|,,|\s\.|\.\.|\(\s|\s\)|\s;|^\s|\s$| ,")
for q in bank:
    for field in ["question", "explanation"]:
        v = q.get(field, "")
        if ARTIFACT.search(v):
            report["whitespace"].append({"id": q["id"], "field": field, "sample": repr(v[:70])})
    for i, o in enumerate(q.get("options", [])):
        if ARTIFACT.search(o):
            report["whitespace"].append({"id": q["id"], "field": f"opt{i}", "sample": repr(o[:70])})

os.makedirs("build", exist_ok=True)
with open("build/quality-report.json", "w", encoding="utf-8") as fp:
    json.dump(report, fp, ensure_ascii=False, indent=2)

# Print summary
print(f"Bank: {len(bank)} questions")
print(f"Near-duplicate FULL (likely dupes):  {len(report['near_dup_full'])}")
print(f"Near-duplicate stems (review):       {len(report['near_dup_stems'])}")
print(f"Casing-variant terms:                {len(report['casing'])}")
print(f"Options with baked letter-prefix:    {len(report['option_prefix'])}")
print(f"Explanation outliers:                {len(report['explanation_outliers'])}")
print(f"Whitespace/punct artifacts:          {len(report['whitespace'])}")
print()
if report["near_dup_full"]:
    print("=== LIKELY DUPLICATES (stem>=.85 or opt-overlap>=.5) ===")
    for e in report["near_dup_full"]:
        print(f"  {e['a']} <-> {e['b']}  stemJ={e['stem_jaccard']} optOv={e['opt_overlap']} same_sec={e['same_section']}")
        print(f"     A: {e['qa']}")
        print(f"     B: {e['qb']}")
if report["near_dup_stems"]:
    print("\n=== NEAR-DUP STEMS (0.70-0.85, review) ===")
    for e in report["near_dup_stems"][:25]:
        print(f"  {e['a']} <-> {e['b']}  stemJ={e['stem_jaccard']} optOv={e['opt_overlap']}")
        print(f"     A: {e['qa']}")
        print(f"     B: {e['qb']}")
if report["casing"]:
    print("\n=== CASING VARIANTS ===")
    for term, variants in sorted(report["casing"].items()):
        print(f"  {term}: {variants}")
if report["ci_distribution"]:
    print("\n=== correctIndices distribution by format ===")
    for f, dist in report["ci_distribution"].items():
        print(f"  {f}: {dist}")
