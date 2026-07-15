# 症例要約 提出前セルフチェック（ブラウザ版）

Python もインストールも不要。**`index.html` をブラウザで開くだけ**で動く、専攻医向けの提出前チェックです。
マスク版Word（.docx）をドラッグ＆ドロップすると、個人情報の残存に加えて表記・構成まで、
Python版 ReportChecker と同じルールでチェックします（フォント等の書式チェックは、レポート記入がKIDSに移行したため廃止）。

**公開URL: https://atsu4i.github.io/ReportChecker-Web/**

> **プライバシー**: ファイルは端末のブラウザ内だけで処理され、どこにもアップロードされません。
> すべてクライアント側（JavaScript）で完結します。

## 使い方

- **URL配布（推奨）**: 上記 GitHub Pages のURLを開くだけ。
- **単体で開く**: `index.html` をダブルクリック（`file://`）。`vendor/` と `js/` を同じ場所に置いたまま配布してください。

## チェック内容

- **個人情報**: 具体的な日付（西暦・和暦・月日）=ERROR、カルテID等の数字列・氏名らしき表現=WARN、
  マスク版ヘッダ欄（患者ID・受持期間・年齢・性別）の実データ残存=ERROR、分野番号の未記入=ERROR。相対表記は許容。
- **構成**: 必須セクション（主訴・現病歴・入院時所見・検査所見・鑑別診断・経過・家族への説明・退院後経過）。
- **表記/NG表現**: にて／採血／〜と思われる／●●剤／カ月／体言＋あり 等、年齢呼称、検査名称、現症・検査の記載順。
- **記号/スペース/略号/かな/薬用量**: 数値と単位のスペース、カンマ後スペース、全角/半角混在、μ、標準外括弧、句読点統一、略号統一、かな表記、小児薬用量。
- **分量**: 症例要約の推定行数（30行以内・80%以上）。

> **書式チェックは廃止**（フォント・ポイント数・SpO₂の下付き等）。レポート記入がKIDS（プレーンテキスト）に移行し、
> これらの書式はそもそも表現できないため。文字そのものに関する指摘（スペース・記号・略号など）は引き続き有効です。

## 構成

| パス | 役割 |
| :---- | :---- |
| `index.html` | 画面（シェル）＋スタイル |
| `js/checker.js` | **チェックロジック本体**（Python版 `checker/` を移植した単一ソース。ブラウザ/Node 両対応） |
| `js/app.js` | UI（ドロップ・症例カード・サマリ・連携ビュー・Markdown出力） |
| `vendor/jszip.min.js` | .docx（ZIP）展開 |
| `vendor/mammoth.browser.min.js` | Word→HTML プレビュー変換 |
| `test/` | Python版との一致を検証するゴールデン差分ハーネス（配布物ではない） |

## ロジックの出所と検証

`js/checker.js` は Python版 ReportChecker の `checker/`（parser / 各ルール / format_check / layout / runner の masked 経路）を
JavaScript に移植した「単一ソース」です。`.docx` は JSZip で展開し `word/document.xml` を DOMParser で解析します。

### Python版との一致検証

`test/` のハーネスで、同じサンプル群を JS版と Python版（マスクモード）に通し、
`(category, severity, message, match_text)` 単位で突き合わせています。

```bash
cd test && npm install
node run_js.js ../../ReportChecker/samples/*.docx > js.json
python run_py.py ../../ReportChecker/samples/*.docx > py.json   # フル版リポジトリの checker/ を使用
python diff.py js.json py.json
```

23サンプルで **253 件が完全一致**。差分は「日本語の直後に続くラテン表記（`100mg投与`・非下付きの `SpO2` 等）」を
JS版が追加検出する 6 件のみで、これは Python の Unicode 単語境界 `\b` の取りこぼしを JS 版が拾うもの（＝より厳密）です。
