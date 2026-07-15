"""JS版とPython版の findings JSON を突き合わせて差分を表示する。
使い方: python diff.py js.json py.json
比較キー: (category, severity, message, match_text) の多重集合。
"""
import json
import sys
from collections import Counter


def load(p):
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def key(fnd):
    return (fnd["category"], fnd["severity"], fnd["message"], fnd["match_text"])


def main():
    js = load(sys.argv[1])
    py = load(sys.argv[2])

    files = sorted(set(js) | set(py))
    total_only_js = 0
    total_only_py = 0
    total_match = 0
    mismatched_files = []

    for f in files:
        jf = js.get(f, {})
        pf = py.get(f, {})
        jc = Counter(key(x) for x in jf.get("findings", []))
        pc = Counter(key(x) for x in pf.get("findings", []))

        only_js = jc - pc
        only_py = pc - jc
        match = sum((jc & pc).values())
        total_match += match
        total_only_js += sum(only_js.values())
        total_only_py += sum(only_py.values())

        if only_js or only_py or jf.get("error"):
            mismatched_files.append(f)
            print(f"\n=== {f} ===")
            if jf.get("error"):
                print(f"  JS error: {jf['error']}")
            print(f"  一致: {match}  / JSのみ: {sum(only_js.values())} / PYのみ: {sum(only_py.values())}")
            for k, n in only_py.items():
                print(f"    [PYのみ x{n}] {k[1]}/{k[0]}: {k[2]}  «{k[3]}»")
            for k, n in only_js.items():
                print(f"    [JSのみ x{n}] {k[1]}/{k[0]}: {k[2]}  «{k[3]}»")

    print("\n" + "=" * 60)
    print(f"ファイル数: {len(files)}  / 完全一致ファイル: {len(files) - len(mismatched_files)}")
    print(f"一致 finding: {total_match}  / JSのみ: {total_only_js} / PYのみ: {total_only_py}")
    if total_only_js == 0 and total_only_py == 0:
        print("✅ 完全一致")
    else:
        print("⚠️ 差分あり（上記参照）")


if __name__ == "__main__":
    main()
