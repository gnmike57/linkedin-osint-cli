import sys, os, io, json
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
root = os.path.dirname(os.path.abspath(__file__))
base = os.path.join(root, "legacy", "python", "linkedin2username-master")
src = open(os.path.join(base, "linkedin2username.py"), encoding="utf-8").read()
lines = [l for l in src.split("\n") if not l.strip().startswith(("import requests", "import urllib3", "from selenium"))]
ns = {"__name__": "names_lite"}
exec("\n".join(lines), ns)
NM = ns["NameMutator"]
names = ["John Smith", "John Davidson-Smith", "John-Paul Smith-Robinson", "Jos\u00e9 Gonz\u00e1les", "\U0001f642 Emoji Folks \U0001f642", "Jean-Charles Martin", "Madonna Wayne Gacey"]
for n in names:
    m = NM(n)
    print("NAME", ascii(n))
    print("  fields", {k: ascii(v) for k, v in (m.name or {}).items()})
    for fn in ("f_last", "f_dot_last", "last_f", "first_dot_last", "first_l", "first"):
        vals = sorted(getattr(m, fn)()) if m.name else []
        print("  ", fn, [ascii(v) for v in vals])
print("CLEAN CASES")
for c in ["  \U0001f642\u00c0n\u00e8\u00f4\u00f5\u00f6    \u00df\u00ef\U0001f642  ", "Dr. Hannibal Lecter, PhD.", "Mr. Fancy Pants MD, PhD, MBA", "Mr. Cert Dude (OSCP, OSCE)"]:
    print("  ", ascii(c), "->", ascii(NM.clean_name(c)))
print("HYPHEN")
for h in ["smith", "davidson-smith", "a-b-c"]:
    print("  ", h, NM._hyphen_variants(h))
print("SPLIT CASES")
for s in ["madonna wayne gacey", "twiggy ramirez", "brian warner is marilyn manson", "jean-charles martin", "john davidson-smith", "john-paul smith-robinson"]:
    print("  ", ascii(s), "->", NM.split_name(s))
print("FIND_EMPLOYEES")
for f in ("tests/mock-employee-response", "tests/mock-employee-response-last-page"):
    data = open(os.path.join(base, f), encoding="utf-8").read()
    print("  ", f, ns["find_employees"](data))
rules_path = os.path.join(root, "legacy", "python", "linkedin-osint-toolkit-main", "src", "classification_rules.json")
r = json.load(open(rules_path, encoding="utf-8"))
print("RULES keys:", sorted(r.keys()))
print("RULES meta:", r.get("meta"))
print("RULES counts:", {k: len(r[k]) for k in r if isinstance(r[k], (list, dict))})
print("RULES hierarchy_levels:", json.dumps(r["hierarchy_levels"]))
print("RULES first hierarchy_pattern:", json.dumps(r["hierarchy_patterns"][0]))
print("RULES non_title[:6]:", r["non_title_patterns"][:6])
print("RULES company_name[:6]:", r.get("company_name_patterns", [])[:6])
print("RULES divisions:", list(r["division_keywords"].keys()))
