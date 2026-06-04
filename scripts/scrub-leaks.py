"""One-shot scrub of source-leaking phrases from bank.json.

Reads public/assets/data/bank.json, rewrites question/options/explanation
to remove references to "the course / the PDF / the slide / the module / etc.",
writes the result back, and re-scans to surface anything the regex didn't catch.
"""
import json, re, os, sys

PATH = 'public/assets/data/bank.json'
BACKUP = 'build/bank-pre-scrub.json'
OUT = 'build/bank-scrubbed.json'

with open(PATH, encoding='utf-8') as fp:
    bank = json.load(fp)

# Backup before mutating
os.makedirs('build', exist_ok=True)
with open(BACKUP, 'w', encoding='utf-8') as fp:
    json.dump(bank, fp, ensure_ascii=False, indent=2)

SOURCES = r"(?:course|PDF|module|chapter|reference|slide|page|figure|guide|book|training|material|manual|textbook|document|syllabus)"
INTRO_VERBS = r"(?:states?|defines?|explicitly\s+states?|quotes?|outlines?|notes?|says?|describes?|lists?|specifies?|reports?|mentions?|cites?|presents?|shows?|references?|enumerates?|reports|reads)"
PAST = r"(?:defined|described|listed|presented|shown|cited|stated|mentioned|noted|specified|reported|enumerated|covered|introduced)"

EXPL_PREFIX = [
    re.compile(rf"^The course(?:'s)?(?:\s+[\"'][^\"']+[\"']\s+(?:page|diagram|slide|table|section)\s*)?\s+{INTRO_VERBS}\s+(?:that\s+)?", re.I),
    re.compile(rf"^The PDF\s+{INTRO_VERBS}\s+(?:that\s+)?", re.I),
    re.compile(rf"^The manual\s+", re.I),
    re.compile(rf"^The slide\s+{INTRO_VERBS}\s+(?:that\s+)?", re.I),
    re.compile(rf"^Per\s+the\s+{SOURCES}(?:'s)?[^.,;]*?,\s*", re.I),
    re.compile(rf"^According\s+to\s+the\s+{SOURCES}(?:'s)?[^.,;]*?,\s*", re.I),
    re.compile(rf"^In\s+the\s+{SOURCES}(?:'s)?[^.,;]*?,\s*", re.I),
]

INFIX = [
    # "X listed/etc. in the course as Y" -> "X Y" (drop the meta, drop the connector "as" too)
    (re.compile(rf"\s+(?:explicitly\s+)?{PAST}\s+in\s+the\s+{SOURCES}\s+as\b", re.I), ''),
    (re.compile(rf",\s*as\s+{PAST}\s+in\s+the\s+{SOURCES},", re.I), ','),
    (re.compile(rf",\s*{PAST}\s+in\s+the\s+{SOURCES},", re.I), ','),
    (re.compile(rf"\s+as\s+{PAST}\s+in\s+the\s+{SOURCES}\b", re.I), ''),
    (re.compile(rf"\s+{PAST}\s+in\s+the\s+{SOURCES}\b", re.I), ''),
    (re.compile(rf"\s+in\s+the\s+{SOURCES}\b", re.I), ''),
    (re.compile(rf"\s+in\s+this\s+{SOURCES}\b", re.I), ''),
    (re.compile(rf"\s+from\s+the\s+{SOURCES}\b", re.I), ''),
    (re.compile(rf"\s+per\s+the\s+{SOURCES}\b", re.I), ''),
    (re.compile(rf"\s+according\s+to\s+the\s+{SOURCES}\b", re.I), ''),
    (re.compile(r"The course'?s\s+[\"'][^\"']+[\"']\s+(?:page|diagram|slide|table|section)\s+", re.I), ''),
    (re.compile(r"\s+matches\s+the\s+slide\s+exactly", re.I), ' is correct'),
    (re.compile(r"\s+match(?:es)?\s+the\s+slide\b", re.I), ' are correct'),
    (re.compile(r"\bthe\s+slide\s+(?:states?|shows?|says?|notes?|specifies?|presents?)\s+", re.I), ''),
    (re.compile(r"\bthe\s+slide\b", re.I), 'the standard architecture'),
    (re.compile(r"\bthe\s+manual\b", re.I), 'standard installation'),
    (re.compile(r"\bthe\s+PDF\b", re.I), 'CAS'),
    (re.compile(r"\bthe\s+course\b(?:'s)?", re.I), 'standard CAS'),
    (re.compile(r"\bthe\s+official\s+syllabus(?:'s)?\s+[\"'][^\"']+[\"']\s+(?:page|diagram|slide|table|section)\b", re.I), ''),
    (re.compile(r"\bthe\s+official\s+syllabus(?:'s)?\b", re.I), 'CAS'),
    (re.compile(r"\bthe\s+(?:introduction|maintenance|deploy(?:ing)?|basic|advanced|infrastructure)\s+(?:module|chapter|section|guide|pdf)", re.I), 'this topic area'),
    (re.compile(r"\bCAS\s+(?:Introduction|Maintenance|Deployment|Basic|Advanced|Infrastructure)\s+(?:module|chapter|guide|pdf)", re.I), 'CAS'),
    # Outright "Module 4" / "Module Maintenance" etc.
    (re.compile(r"\bModule\s+\d+\b", re.I), 'this topic'),
    # "the reference" when not "reference port" etc.
    (re.compile(r"\bthe\s+reference\b(?!\s+(?:port|architecture|implementation|design|configuration|model|table|guide|number))", re.I), 'the standard'),
]

CLEANUP = [
    (re.compile(r",\s*,"), ','),
    (re.compile(r"\s+([,.;:])"), r'\1'),
    (re.compile(r"\s{2,}"), ' '),
    (re.compile(r"^\s*[,;]\s*"), ''),
    (re.compile(r"\.\s*\."), '.'),
    (re.compile(r"^\s+"), ''),
    (re.compile(r"\s+$"), ''),
]


def rewrite(text):
    if not text:
        return text
    # Prefix pass — strip "The course states/defines/etc." prefix without auto-capitalizing
    # (proper nouns like "vMotion" must keep their original case)
    for pat in EXPL_PREFIX:
        m = pat.match(text)
        if m:
            text = text[m.end():]
            # Only capitalize first letter if it's a sentence-start word (starts with a lowercase non-proper-noun letter).
            # Heuristic: capitalize only if the first token is a common-word stem (any/the/a/this/that/which/etc.) or starts a fully-lowercase token.
            if text:
                first_token = text.split(" ", 1)[0] if " " in text else text
                # If first token is fully lowercase or all-caps, capitalize first letter; if mixed (proper noun like "vMotion", "iSCSI"), leave it.
                if first_token.islower() or first_token.isupper():
                    text = text[0].upper() + text[1:]
            break
    # Infix pass — until stable
    for _ in range(5):
        before = text
        for pat, repl in INFIX:
            text = pat.sub(repl, text)
        if text == before:
            break
    # Cleanup
    for pat, repl in CLEANUP:
        text = pat.sub(repl, text)
    return text


changed_fields = 0
changed_qs = set()
diffs = []  # for reporting
for q in bank:
    for field in ('question', 'explanation'):
        before = q.get(field, '')
        after = rewrite(before)
        if after != before:
            q[field] = after
            changed_fields += 1
            changed_qs.add(q['id'])
            diffs.append((q['id'], field, before, after))
    new_opts = []
    opts_changed = False
    for o in q.get('options', []):
        no = rewrite(o)
        if no != o:
            opts_changed = True
            diffs.append((q['id'], 'option', o, no))
        new_opts.append(no)
    if opts_changed:
        q['options'] = new_opts
        changed_fields += 1
        changed_qs.add(q['id'])

print(f'Rewrote {changed_fields} fields across {len(changed_qs)} questions')

LEAK = re.compile(
    r'\b('
    r'the course[\'s]*'
    r'|the\s+pdf'
    r'|the\s+(study\s+)?(material|guide|manual|textbook|training|reference|book)\b'
    r'|the\s+(module|chapter|section\s+\d+|slide|page\s+\d+|figure|table\s+\d+)\b'
    r'|in\s+(this|the)\s+(course|module|chapter|book|guide|material|training|pdf|document|page|slide|reference)\b'
    r'|per\s+the\s+(course|module|chapter|book|guide|material|training|pdf|document|page|slide|reference)\b'
    r'|according\s+to\s+the\s+(course|module|chapter|book|guide|material|training|pdf|document|page|slide|reference)\b'
    r'|(as\s+)?(listed|described|defined|stated|mentioned|shown|noted)\s+in\s+the\s+(course|module|chapter|book|guide|material|training|pdf|document|page|slide|reference)\b'
    r'|the\s+(intro(duction)?|maintenance|deploy(ing)?|basic|advanced|infrastructure)\s+(module|chapter|section|guide|pdf)\b'
    r'|CAS\s+(Introduction|Maintenance|Deployment|Basic|Advanced|Infrastructure)\s+(module|chapter|guide|pdf)\b'
    r')',
    re.IGNORECASE,
)

remaining = []
for q in bank:
    fields = [('question', q['question'])]
    for i, o in enumerate(q.get('options', [])):
        fields.append((f'options[{i}]', o))
    fields.append(('explanation', q.get('explanation', '')))
    for field, text in fields:
        m = LEAK.search(text)
        if m:
            remaining.append({'id': q['id'], 'field': field, 'match': m.group(0), 'context': text[max(0, m.start()-20):m.end()+30]})

print(f'\nRemaining leaks: {len(remaining)}')
for r in remaining[:40]:
    print(f'  {r["id"]:>18}  {r["field"]:>14}  "{r["match"]}"  -- "{r["context"][:90]}"')
if len(remaining) > 40:
    print(f'  ... and {len(remaining) - 40} more')

with open(OUT, 'w', encoding='utf-8') as fp:
    json.dump(bank, fp, ensure_ascii=False, indent=2)
print(f'\nWrote scrubbed bank to {OUT} (review before promoting)')
