"""Pre-scan the live bank for:
  - Near-duplicate stems (Jaccard similarity on tokenised stems)
  - Cross-module questions that test the same fact
  - Proper-noun / acronym casing variants
  - Explanation-style outliers (too short, too long, missing trailing period, etc.)
  - Option-style outliers (mixed letter prefixes, drastically uneven lengths)

Outputs:
  - build/prescan/dups.json      — near-duplicate pairs
  - build/prescan/casing.json    — term variants
  - build/prescan/outliers.json  — style outliers
"""
import json, re, os
from collections import defaultdict, Counter
from itertools import combinations

PATH = "public/assets/data/bank.json"
OUT = "build/prescan"
os.makedirs(OUT, exist_ok=True)

b = json.load(open(PATH, encoding="utf-8"))

# --- Tokenisation -----------------------------------------------------------
WORD = re.compile(r"[A-Za-z][A-Za-z0-9]+")
STOP = set("the a an of in on at by for to from with which what about into is are was were be been being has have had which whose this that those these and or not but if then so as such it its".split())

def tokens(text):
    return [t.lower() for t in WORD.findall(text) if t.lower() not in STOP and len(t) > 2]

def jaccard(a, b):
    sa, sb = set(a), set(b)
    if not sa or not sb: return 0.0
    return len(sa & sb) / len(sa | sb)

# --- 1) Near-duplicate stem detection --------------------------------------
print("=" * 60)
print("Near-duplicate stems (Jaccard >= 0.6)")
print("=" * 60)

stems = [(q["id"], q["section"], q["question"], tokens(q["question"])) for q in b]
near_dups = []
for (id1, s1, t1, tok1), (id2, s2, t2, tok2) in combinations(stems, 2):
    j = jaccard(tok1, tok2)
    if j >= 0.60:
        near_dups.append({"id1": id1, "id2": id2, "section1": s1, "section2": s2, "jaccard": round(j, 3), "stem1": t1, "stem2": t2})

near_dups.sort(key=lambda x: -x["jaccard"])
print(f"Found {len(near_dups)} near-duplicate pairs")
for d in near_dups[:20]:
    cross = " (CROSS-MODULE)" if d["section1"] != d["section2"] else ""
    print(f"  {d['jaccard']:.2f}  {d['id1']} <-> {d['id2']}{cross}")
    print(f"        {d['stem1'][:90]}")
    print(f"        {d['stem2'][:90]}")
with open(f"{OUT}/dups.json", "w", encoding="utf-8") as fp:
    json.dump(near_dups, fp, ensure_ascii=False, indent=2)

# --- 2) Casing variants for known H3C/CAS terms ----------------------------
print()
print("=" * 60)
print("Casing variants (proper nouns / acronyms)")
print("=" * 60)

# canonical -> variant matcher (case-insensitive find)
CANONICAL_TERMS = [
    "vMotion", "vSwitch", "vNIC", "iSCSI", "CVM", "CVK", "CAS", "H3C",
    "OCFS2", "OVF", "OVA", "vGPU", "vCPU", "SR-IOV", "VLAN", "RAID 0",
    "RAID 1", "RAID 5", "RAID 6", "RAID 10", "FBWC", "BBWC", "NUMA",
    "DRS", "DPM", "FT", "HA", "DR", "RPO", "RTO", "IQN", "FC", "WWN",
    "DHCP", "DNS", "NTP", "PCIe", "PCI-E", "K8s", "SDN", "ONEStor",
    "iLO", "HDM", "GPT", "MBR", "TPS", "DPM", "DCB", "qcow2", "qemu-img",
    "qemu", "virsh", "libvirt", "TCP", "UDP", "MTU", "IP",
]

variants = defaultdict(Counter)
for q in b:
    fields = [q["question"]] + list(q.get("options", [])) + [q.get("explanation", "")]
    for f in fields:
        if not f: continue
        for canon in CANONICAL_TERMS:
            # match case-insensitive variants, NOT the canonical (we want to surface non-canonical)
            pattern = re.compile(r"\b" + re.escape(canon).replace(r"\ ", r"\s+") + r"\b", re.IGNORECASE)
            for m in pattern.finditer(f):
                hit = m.group(0)
                if hit != canon:
                    variants[canon][hit] += 1

print(f"Found {sum(len(v) for v in variants.values())} non-canonical term occurrences")
for canon, ctr in sorted(variants.items()):
    if ctr:
        print(f"  {canon:>10}  ->  " + ", ".join(f'"{v}"x{c}' for v, c in ctr.most_common()))

with open(f"{OUT}/casing.json", "w", encoding="utf-8") as fp:
    json.dump({k: dict(v) for k, v in variants.items()}, fp, ensure_ascii=False, indent=2)

# --- 3) Style outliers ------------------------------------------------------
print()
print("=" * 60)
print("Style outliers")
print("=" * 60)
outliers = []

# Stem length distribution
stem_lens = [len(q["question"]) for q in b]
mean_stem = sum(stem_lens) / len(stem_lens)
print(f"Stem length: avg {mean_stem:.0f}, range {min(stem_lens)}-{max(stem_lens)}")

# Outlier stems
for q in b:
    issues = []
    s = q["question"]
    e = q.get("explanation", "")
    opts = q.get("options", [])

    if len(s) < 30: issues.append(f"very short stem ({len(s)})")
    if len(s) > 280: issues.append(f"very long stem ({len(s)})")

    # Explanation issues
    if len(e) < 40: issues.append(f"very short explanation ({len(e)})")
    if not e.rstrip().endswith((".", "!", "?")): issues.append("explanation does not end with punctuation")
    # Stray double-space
    if "  " in s or "  " in e: issues.append("double-whitespace")
    # Sentence starts with lowercase (after the leak-scrub)
    # Legitimate camelCase technical terms start lowercase — exempt them
    CAMEL = ("vMotion","vSwitch","vNIC","vCPU","vGPU","vDisk","vFW","vFirewall","vFirewalls",
            "iSCSI","iLO","iqn.","qcow2","qemu","virsh","libvirt","eth")
    def lower_ok(text):
        return any(text.startswith(t) for t in CAMEL)
    if e and e[0].islower() and not lower_ok(e): issues.append("explanation starts lowercase")
    if s and s[0].islower() and not lower_ok(s): issues.append("stem starts lowercase")
    # Trailing comma before "is correct"
    if re.search(r",\s+(is|are)\s+correct\?", s): issues.append("stray comma before is/are correct")

    # Option-length disparity
    if opts:
        olens = [len(o) for o in opts]
        if max(olens) > 4 * min(olens) and min(olens) > 0:
            issues.append(f"option length disparity (min {min(olens)}, max {max(olens)})")
    # Option letter prefix mixing: do options start with "A.", "B." etc? (the engine adds these; bank shouldn't)
    letter_prefix = re.compile(r"^[A-E]\.\s")
    prefixed = [bool(letter_prefix.match(o)) for o in opts]
    if any(prefixed) and not all(prefixed):
        issues.append("inconsistent option letter-prefixing")

    if issues:
        outliers.append({"id": q["id"], "issues": issues})

print(f"\n{len(outliers)} questions with style outliers:")
for o in outliers[:25]:
    print(f"  {o['id']:>18}  {'; '.join(o['issues'])}")
if len(outliers) > 25:
    print(f"  ... and {len(outliers) - 25} more")

with open(f"{OUT}/outliers.json", "w", encoding="utf-8") as fp:
    json.dump(outliers, fp, ensure_ascii=False, indent=2)

print()
print("Wrote:", f"{OUT}/dups.json", f"{OUT}/casing.json", f"{OUT}/outliers.json")
