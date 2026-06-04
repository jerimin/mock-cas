"""Merge the 6 per-module coherence-pass outputs into a single bank.json.
Validates schema integrity, reports format/section breakdown, writes the live bank.
"""
import json, glob, os

files = sorted(glob.glob('build/coherence-out/*.json'))
print(f'Loading {len(files)} per-module results')

bank = []
fmt_counts = {'single': 0, 'multi': 0, 'negative': 0}
sec_counts = {}
seen_ids = set()
issues = []

for f in files:
    with open(f, encoding='utf-8') as fp:
        raw = json.load(fp)
    # Accept either a bare array or {section, questions}
    if isinstance(raw, dict) and 'questions' in raw:
        items = raw['questions']
    elif isinstance(raw, list):
        items = raw
    else:
        raise ValueError(f'{f}: unexpected shape')
    print(f'  {os.path.basename(f)}: {len(items)} Q')
    for q in items:
        keys = ('id', 'section', 'format', 'question', 'options', 'correctIndices', 'explanation')
        cleaned = {k: q[k] for k in keys if k in q}
        if cleaned['id'] in seen_ids:
            issues.append(f'DUP id {cleaned["id"]}')
            continue
        seen_ids.add(cleaned['id'])
        bank.append(cleaned)
        fmt_counts[cleaned['format']] += 1
        sec_counts[cleaned['section']] = sec_counts.get(cleaned['section'], 0) + 1
        if len(cleaned['options']) not in (4, 5):
            issues.append(f'{cleaned["id"]} options count {len(cleaned["options"])}')
        for i in cleaned['correctIndices']:
            if i < 0 or i >= len(cleaned['options']):
                issues.append(f'{cleaned["id"]} OOB index {i}')

s, m, n = fmt_counts['single'], fmt_counts['multi'], fmt_counts['negative']
print(f'\nTotal: {len(bank)}')
print(f'Format: {s}s / {m}m / {n}n')
for sec, cnt in sec_counts.items():
    print(f'  {sec}: {cnt}')

print(f'Schema issues: {len(issues)}')
for i in issues[:20]:
    print(' -', i)

out = 'public/assets/data/bank.json'
with open(out, 'w', encoding='utf-8') as fp:
    json.dump(bank, fp, ensure_ascii=False, indent=2)
print(f'\nWrote {out} ({os.path.getsize(out)} bytes)')
