"""Programmatic normalization pass: canonical casing of acronyms / proper nouns,
period-terminate explanations, fix double whitespace and minor punctuation artifacts.

This is the safe-mechanical pass that runs BEFORE the agent coherence pass.
"""
import json, re, os

PATH = "public/assets/data/bank.json"

# Canonical -> (regex matching variants, replacement)
# Order matters: more-specific first.
TERMS = [
    # H3C product / acronym terms — always uppercase
    ("CAS", r"\bcas\b"),
    ("CVK", r"\bcvk\b"),
    ("CVM", r"\bcvm\b"),
    ("H3C", r"\bh3c\b"),
    ("OCFS2", r"\bocfs2\b"),
    ("TPS", r"\btps\b"),
    # File formats — always lowercase
    ("qcow2", r"\bQCOW2\b"),
    ("qemu", r"\bQEMU\b"),
    # Kubernetes canonical: K8s
    ("K8s", r"\bK8S\b"),
]

# IQN special-case: keep canonical "IQN" when capitalised in prose, but
# preserve "iqn." prefix in actual IQN strings like "iqn.2015-08.com.h3c:linux1"
# — so DO NOT mass-normalise "iqn" -> "IQN".

def normalise_casing(text):
    if not text: return text
    for canon, pat in TERMS:
        text = re.sub(pat, canon, text)
    return text

def normalise_punct(text):
    if not text: return text
    # collapse double whitespace
    text = re.sub(r"\s{2,}", " ", text)
    # space-before-punct
    text = re.sub(r"\s+([,.;:!?])", r"\1", text)
    # double commas
    text = re.sub(r",\s*,", ",", text)
    # stray ", is correct?" -> " is correct?"
    text = re.sub(r",\s+(is|are)\s+correct\?", r" \1 correct?", text)
    # leading whitespace
    text = text.strip()
    return text

def ensure_period(text):
    if not text: return text
    text = text.rstrip()
    if text and not text.endswith((".", "!", "?", "”", "\"", ")")):
        text += "."
    return text

def capitalise_first(text):
    if not text: return text
    # Only capitalise if first letter is a-z (NOT proper noun starting with lowercase like vMotion)
    first_token = text.split(" ", 1)[0] if " " in text else text
    if first_token.islower() and first_token not in ("vMotion","vSwitch","vNIC","vCPU","vGPU","iSCSI","qcow2","qemu","virsh","libvirt"):
        return text[0].upper() + text[1:]
    return text

b = json.load(open(PATH, encoding="utf-8"))
changes = 0
for q in b:
    # Question
    new = normalise_punct(normalise_casing(q["question"]))
    new = capitalise_first(new)
    if new != q["question"]:
        q["question"] = new; changes += 1
    # Options
    new_opts = []
    opts_changed = False
    for o in q.get("options", []):
        no = normalise_punct(normalise_casing(o))
        no = capitalise_first(no)
        if no != o: opts_changed = True
        new_opts.append(no)
    if opts_changed:
        q["options"] = new_opts; changes += 1
    # Explanation
    new_e = normalise_punct(normalise_casing(q.get("explanation","")))
    new_e = capitalise_first(new_e)
    new_e = ensure_period(new_e)
    if new_e != q.get("explanation",""):
        q["explanation"] = new_e; changes += 1

print(f"Normalised {changes} fields")

with open(PATH, "w", encoding="utf-8") as fp:
    json.dump(b, fp, ensure_ascii=False, indent=2)
print(f"Wrote {PATH}")
