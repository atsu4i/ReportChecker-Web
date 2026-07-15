"""Python版 run_checks(masked) を samples/*.docx に通し findings を JSON 出力。
使い方: python run_py.py <docx1> <docx2> ...
（ReportChecker（フル版）の checker/ を import できる環境で実行）
"""
import json
import os
import sys

# フル版リポジトリの checker/ を import path に追加
FULL_REPO = "/Users/atsu4i/MyProjects/ReportChecker"
sys.path.insert(0, FULL_REPO)

from checker import run_checks  # noqa: E402


def main():
    out = {}
    for f in sys.argv[1:]:
        result = run_checks(f, mode="masked")
        out[os.path.basename(f)] = {
            "error": None,
            "diagnosis": result.case.diagnosis if result.case else None,
            "findings": [
                {"category": i.category, "severity": i.severity, "message": i.message, "match_text": i.match_text}
                for i in result.issues
            ],
        }
    sys.stdout.write(json.dumps(out, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
