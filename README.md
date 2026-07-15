# 症例要約 提出前セルフチェック（ブラウザ版 MVP）

Python もインストールも不要。**`index.html` をブラウザで開くだけ**で動く、専攻医向けの提出前チェックです。
マスク版Word（.docx）をドラッグ＆ドロップすると、本文に残った実データ（具体的な日付・カルテID・氏名）を検出します。

> **プライバシー**: ファイルは端末のブラウザ内だけで処理され、どこにもアップロードされません。
> すべてクライアント側（JavaScript）で完結します。

## 使い方

- **単体で開く**: `index.html` をダブルクリック（`file://` で開く）。`vendor/` を同じ場所に置いたまま配布してください。
- **URL配布**: このフォルダを静的ホスティング（GitHub Pages 等）に置けば、URLを開くだけで使えます。

## 現状（MVP のスコープ）

- ✅ .docx の症例テーブル抽出（`Docx.gs` の移植 / JSZip + DOMParser）
- ✅ 個人情報チェック（`Pii.gs` の移植：絶対日付=ERROR、カルテID/氏名=WARN、相対表記は許容）
- ✅ マスク版で空欄であるべきヘッダ欄（患者ID・受持期間・年齢）の実データ残存検出
- ✅ 分野番号の記入確認
- ✅ mammoth.js による Word プレビュー＋番号付きハイライト（指摘カードと相互移動）
- ⏳ **未対応**: 表記・構成・NG表現・書式（明朝体/ポイント数/SpO2下付き）など全ルール
  → 次段階（C: ルールをフル版と共通化してブラウザにも載せる）で対応予定。
- ⚠️ 患者性別のヘッダ残存は現状未抽出（Python版フルは検出。C で解消）。

## 構成

| ファイル | 役割 |
| :---- | :---- |
| `index.html` | 本体（UI + チェックロジック、インライン） |
| `vendor/jszip.min.js` | .docx（ZIP）展開 |
| `vendor/mammoth.browser.min.js` | Word→HTML プレビュー変換 |

## ロジックの出所

チェックロジックは Slack Bot（Google Apps Script = JavaScript）側の
`slack_gas/Pii.gs`（PII検出）と `slack_gas/Docx.gs`（.docx抽出）をブラウザ用に移植したものです。
さらに元をたどると Python 版 `checker/rules/pii.py` / `checker/parser.py` と同一ロジックです。
