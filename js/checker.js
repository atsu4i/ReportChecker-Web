/*
 * 症例要約チェッカー（マスク版）— ブラウザ/Node 共用ロジック
 *
 * Python版 `checker/`（parser.py / rules/*.py / format_check.py / layout.py / runner.py）を
 * JavaScript に移植した「単一ソース」。ブラウザでは window.Checker、Node では module.exports。
 *
 * 依存（グローバル）:
 *   - JSZip        … .docx（ZIP）展開
 *   - DOMParser    … word/document.xml 解析（ブラウザ標準 / Nodeは @xmldom/xmldom を global 設定）
 *
 * 公開API:
 *   Checker.check(arrayBuffer) -> Promise<{case, findings, templateOk, error}>
 *   Checker.runMaskedOnCase(caseObj) -> findings[]   （XML不要のテキストルールのみ。テスト用）
 */
(function (global) {
  "use strict";

  var SEVERITY_ERROR = "ERROR";
  var SEVERITY_WARN = "WARN";
  var SEVERITY_INFO = "INFO";
  var WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

  // ==========================================================================
  // helpers（helpers.py 移植）
  // ==========================================================================
  function snippet(text, start, end, around) {
    if (around == null) around = 20;
    var s = Math.max(0, start - around);
    var e = Math.min(text.length, end + around);
    return "…" + text.slice(s, e).replace(/\n/g, " ") + "…";
  }

  function truncate(text, limit) {
    if (text.length <= limit) return text;
    return text.slice(0, limit) + "…";
  }

  function isFullwidth(ch) {
    var code = ch.codePointAt(0);
    return (
      (code >= 0x3000 && code <= 0x303f) ||
      (code >= 0x3040 && code <= 0x309f) ||
      (code >= 0x30a0 && code <= 0x30ff) ||
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0xff00 && code <= 0xffef)
    );
  }

  function visualWidth(text) {
    var w = 0;
    for (var i = 0; i < text.length; i++) {
      w += isFullwidth(text[i]) ? 1.0 : 0.5;
    }
    return w;
  }

  function reEscape(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // Python の float 文字列化に合わせる（8 -> "8.0", 10.5 -> "10.5"）。
  function pyFloat(n) {
    return Number.isInteger(n) ? n.toFixed(1) : String(n);
  }

  // 結果コレクタ（models.py CheckResult 相当）
  function Result() {
    this.issues = [];
    this.caseObj = null;
  }
  Result.prototype.add = function (o) {
    this.issues.push({
      category: o.category,
      severity: o.severity,
      message: o.message,
      snippet: o.snippet || "",
      suggestion: o.suggestion || "",
      match_text: o.match_text || "",
    });
  };

  // 全 match をイテレートする（/g 前提）。lastIndex を毎回リセット。
  function eachMatch(re, text, fn) {
    re.lastIndex = 0;
    var m;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) { re.lastIndex++; continue; }
      fn(m);
    }
  }

  // ==========================================================================
  // NG表現（ng_words.py）
  // ==========================================================================
  var NG_WORD_RULES = [
    ["にて", "「にて」は曖昧な助詞。多用を避ける", "「で」「として」など"],
    ["採血(?!管|針|室|者)", "「採血」は手技。検査結果の意味では「血液検査」", "血液検査"],
    ["まずまず", "口語表現「まずまず」は使わない", "具体的な所見や数値で記述"],
    ["と思われる", "責任回避表現「〜と思われる」", "「〜と思う」「〜と判断する」"],
    ["と考えられる", "責任回避表現「〜と考えられる」", "「〜と考える」"],
    ["にも関わらず", "「関わらず」は誤用", "「にもかかわらず」または「にも拘わらず」"],
    ["利尿剤", "薬品は「●●薬」", "利尿薬"],
    ["抗生剤", "薬品は「●●薬」", "抗菌薬"],
    ["抗菌剤", "薬品は「●●薬」", "抗菌薬"],
    ["鎮痛剤", "薬品は「●●薬」", "鎮痛薬"],
    ["解熱剤", "薬品は「●●薬」", "解熱薬"],
    ["鎮静剤", "薬品は「●●薬」", "鎮静薬"],
    ["抗痙攣剤", "薬品は「●●薬」", "抗けいれん薬 / 抗てんかん薬"],
    ["ステロイド剤", "薬品は「●●薬」", "ステロイド薬"],
    ["カ月", "「カ月」（カタカナのカ）はNG", "か月"],
    ["カ年", "「カ年」（カタカナのカ）はNG", "か年"],
  ];
  var TAIGEN_ARI = /(発熱|不機嫌|腹痛|嘔吐|下痢|咳嗽|咳|喘鳴|湿疹|発疹|皮疹|腫脹|疼痛|頭痛|意識障害|呼吸困難|チアノーゼ|哺乳低下)あり/g;
  var MO_CONJ = /(投与する|処方する|加療する|治療する|施行する|ある|なる|する)も(?![のとが、。])/g;
  var YORI_TIME = /(\d{1,2}月\d{1,2}日|\d{1,2}日|\d{1,2}時|入院\d+日目|当日|前日|翌日)より/g;

  function checkNgWords(text, result) {
    NG_WORD_RULES.forEach(function (rule) {
      var re = new RegExp(rule[0], "g");
      eachMatch(re, text, function (m) {
        result.add({
          category: "NG表現", severity: SEVERITY_WARN, message: rule[1],
          snippet: snippet(text, m.index, m.index + m[0].length),
          match_text: m[0], suggestion: rule[2],
        });
      });
    });
    eachMatch(TAIGEN_ARI, text, function (m) {
      result.add({
        category: "NG表現", severity: SEVERITY_WARN, message: "「体言＋あり」は文章中に使わない",
        snippet: snippet(text, m.index, m.index + m[0].length),
        match_text: m[0], suggestion: m[1] + "がみられた / " + m[1] + "を認めた",
      });
    });
    eachMatch(MO_CONJ, text, function (m) {
      result.add({
        category: "NG表現", severity: SEVERITY_WARN, message: "「も」を接続助詞として使わない",
        snippet: snippet(text, m.index, m.index + m[0].length),
        match_text: m[0], suggestion: "「〜したが」など",
      });
    });
    eachMatch(YORI_TIME, text, function (m) {
      result.add({
        category: "NG表現", severity: SEVERITY_WARN, message: "時の起点には「より」ではなく「から」を用いる",
        snippet: snippet(text, m.index, m.index + m[0].length),
        match_text: m[0], suggestion: m[1] + "から",
      });
    });
  }

  // ==========================================================================
  // かな表記（kana.py）
  // ==========================================================================
  var KANA_WORDS = [
    ["一旦", "いったん", null],
    ["未だ", "いまだ", null],
    ["恐れ", "おそれ", null],
    ["及び", "および", null],
    ["且つ", "かつ", null],
    ["来す", "きたす", "(?<![一-龥])来す"],
    ["毎に", "ごとに", null],
    ["過ぎない", "すぎない", null],
    ["全て", "すべて", null],
    ["但し", "ただし", null],
    ["為に", "ために", null],
    ["掴む", "つかむ", null],
    ["出来る", "できる", null],
    ["初めて", "はじめて", null],
    ["欲しい", "ほしい", null],
    ["又は", "または", null],
  ];
  function checkKana(text, result) {
    KANA_WORDS.forEach(function (row) {
      var kanji = row[0], kana = row[1], pattern = row[2];
      var re = new RegExp(pattern != null ? pattern : reEscape(kanji), "g");
      eachMatch(re, text, function (m) {
        result.add({
          category: "かな表記", severity: SEVERITY_INFO,
          message: "「" + kanji + "」はかな表記が望ましい",
          snippet: snippet(text, m.index, m.index + m[0].length),
          match_text: m[0], suggestion: kana,
        });
      });
    });
  }

  // ==========================================================================
  // スペース（spacing.py）
  // ==========================================================================
  var UNIT_NO_SPACE = /(?<![\d,])(\d+(?:\.\d+)?)(mg|kg|g|mL|L|µL|μL|\/μL|\/µL|\/uL|mmHg|mEq\/L|mEq|U\/L|IU\/L|U\/mL|IU\/mL|mmol\/L|µmol\/L|μmol\/L|mol\/L|\/dL|\/μL|\/min|\/hr|\/日|\/分)\b/g;
  var PERCENT_DEG_WITH_SPACE = /\d+(?:\.\d+)?\s+(%|℃|°)/g;
  function checkSpacing(text, result) {
    eachMatch(UNIT_NO_SPACE, text, function (m) {
      result.add({
        category: "スペース", severity: SEVERITY_WARN, message: "数値と単位の間に半角スペースを入れる",
        snippet: snippet(text, m.index, m.index + m[0].length),
        match_text: m[0], suggestion: m[1] + " " + m[2],
      });
    });
    eachMatch(PERCENT_DEG_WITH_SPACE, text, function (m) {
      result.add({
        category: "スペース", severity: SEVERITY_WARN, message: "%・℃・° の前にはスペースを入れない",
        snippet: snippet(text, m.index, m.index + m[0].length),
        match_text: m[0], suggestion: "（数値と記号を続けて書く）",
      });
    });
  }

  // ==========================================================================
  // 略号（abbrev.py）
  // ==========================================================================
  var ABBREV_RULES = [
    ["\\bCRE\\b", "Cre"],
    ["\\bTBIL\\b", "T-Bil"],
    ["\\bDBIL\\b", "D-Bil"],
    ["\\bALP\\b", "Al-P"],
    ["\\bALB\\b", "Alb"],
    ["\\bAL-P\\b", "Al-P"],
  ];
  function checkAbbrev(text, result) {
    ABBREV_RULES.forEach(function (rule) {
      var re = new RegExp(rule[0], "g");
      eachMatch(re, text, function (m) {
        result.add({
          category: "略号", severity: SEVERITY_INFO, message: "略号は大文字／小文字を統一する",
          snippet: snippet(text, m.index, m.index + m[0].length),
          match_text: m[0], suggestion: rule[1],
        });
      });
    });
  }

  // ==========================================================================
  // 小児薬用量（pediatric_dose.py）
  // ==========================================================================
  var PEDIATRIC_DOSE_DRUGS = [
    "アセトアミノフェン", "アシクロビル", "アジスロマイシン", "アムロジピン", "アモキシシリン",
    "アンピシリン", "クラリスロマイシン", "クリンダマイシン", "セファクロル", "セファゾリン",
    "セファゾリンナトリウム", "セファレキシン", "セフェピム", "セフカペン", "セフジトレン",
    "セフトリアキソン", "セフォタキシム", "バンコマイシン", "フロセミド", "プレドニゾロン", "メロペネム",
  ];
  var PEDIATRIC_DOSE_DRUG_SRC = PEDIATRIC_DOSE_DRUGS.slice()
    .map(reEscape).sort(function (a, b) { return b.length - a.length; }).join("|");
  var WEIGHT_BASED_DOSE = /(?:mg|g|µg|μg)\s*\/\s*kg|kg\s*(?:あたり|当たり)|体重\s*\d/;
  var CLASS_ONLY_STEROID_WITH_DOSE = /ステロイド(?:薬|点滴|静注|投与|内服)?\s*\d+(?:\.\d+)?\s*(?:mg|g|µg|μg)\s*\/\s*kg/g;

  function canonicalPediatricDrug(drug) {
    return drug === "セファゾリンナトリウム" ? "セファゾリン" : drug;
  }
  function sentenceBounds(text, start, end) {
    var sStart = Math.max(text.lastIndexOf("。", start - 1), text.lastIndexOf(".", start - 1), text.lastIndexOf("\n", start - 1));
    var cands = [text.indexOf("。", end), text.indexOf(".", end), text.indexOf("\n", end)].filter(function (p) { return p !== -1; });
    sStart = sStart === -1 ? 0 : sStart + 1;
    var sEnd = cands.length ? Math.min.apply(null, cands) : Math.min(text.length, end + 80);
    return [sStart, sEnd];
  }
  function checkPediatricDose(text, result) {
    eachMatch(CLASS_ONLY_STEROID_WITH_DOSE, text, function (m) {
      result.add({
        category: "薬用量", severity: SEVERITY_INFO, message: "ステロイドの具体的な薬剤名が見当たらない",
        snippet: snippet(text, m.index, m.index + m[0].length),
        match_text: m[0], suggestion: "プレドニゾロン、メチルプレドニゾロンなど具体的な薬剤名を記載する",
      });
    });

    var drugRe = new RegExp(PEDIATRIC_DOSE_DRUG_SRC, "g");
    var covered = {};
    eachMatch(drugRe, text, function (m) {
      var b = sentenceBounds(text, m.index, m.index + m[0].length);
      if (WEIGHT_BASED_DOSE.test(text.slice(b[0], b[1]))) covered[canonicalPediatricDrug(m[0])] = true;
    });
    var drugRe2 = new RegExp(PEDIATRIC_DOSE_DRUG_SRC, "g");
    eachMatch(drugRe2, text, function (m) {
      if (covered[canonicalPediatricDrug(m[0])]) return;
      var b = sentenceBounds(text, m.index, m.index + m[0].length);
      var sentence = text.slice(b[0], b[1]);
      if (WEIGHT_BASED_DOSE.test(sentence)) return;
      result.add({
        category: "薬用量", severity: SEVERITY_INFO,
        message: "小児薬用量として「" + m[0] + "」の体重あたり量が見当たらない",
        snippet: snippet(text, m.index, m.index + m[0].length),
        match_text: m[0], suggestion: m[0] + " ○○ mg/kg/日 など、体重あたり量を併記する",
      });
    });
  }

  // ==========================================================================
  // 構成 必須セクション（structure.py）
  // ==========================================================================
  var REQUIRED_SECTIONS = [
    ["主訴", ["【主訴】", "^\\s*主訴[:：]"]],
    ["現病歴", ["【現病歴】", "^\\s*現病歴[:：]"]],
    ["入院時所見 / 現症", ["【?(?:入院|来院|初診)時(?:身体|診察)?(?:所見|現症)】?", "【?身体所見】?", "(?:入院|来院|初診)時.*?(?:所見|現症)"]],
    ["検査所見", ["【?検査(?:結果|所見|データ|成績)】?", "【?入院時検査】?", "検査.{0,4}(?:結果|所見)"]],
    ["鑑別診断", ["【?鑑別(?:診断|疾患)】?", "鑑別.{0,15}(?:挙げた|考えた|診断|疾患|含めた)"]],
    ["経過 / 入院経過", ["【?入院(?:後)?経過】?", "【?外来経過】?", "【?臨床経過】?", "【?治療経過】?", "【?外来での経過】?", "【?治療方針と経過】?", "【?治療方針(?:および|及び|と)?(?:入院|外来)?経過】?", "【経過】", "^\\s*経過[:：]"]],
    ["家族への説明 / IC", ["【?(?:家族|患者|保護者)(?:への|に)説明】?", "説明し.{0,8}同意", "インフォームドコンセント", "IC"]],
    ["退院後経過 / 退院後の指導", ["【?退院後(?:経過|指導|計画|の.{0,4}(?:経過|指導))?】?", "外来.{0,5}経過観察", "フォローアップ", "退院後.{0,10}指導"]],
  ];
  function checkStructure(text, result, admissionType) {
    var isOutpatient = admissionType === "外来症例";
    REQUIRED_SECTIONS.forEach(function (row) {
      var label = row[0], patterns = row[1];
      if (isOutpatient && label.indexOf("退院後") >= 0) return;
      var found = patterns.some(function (p) { return new RegExp(p).test(text); });
      if (!found) {
        var displayLabel = label;
        if (isOutpatient && label.indexOf("経過") === 0) displayLabel = "経過 / 外来経過";
        result.add({
          category: "構成", severity: SEVERITY_ERROR,
          message: "必須項目「" + displayLabel + "」が見当たらない",
          suggestion: "【" + displayLabel + "】の項を設ける",
        });
      }
    });
  }

  // ==========================================================================
  // 記号系（symbols.py）
  // ==========================================================================
  var COMMA_NO_SPACE = /,(?![\s\d])/g;
  var MU_GREEK = /μ/g;
  var UNUSUAL_BRACKETS = /[〔〕《》≪≫〘〙〚〛]/g;
  var JP_PERIOD = /。/;
  var EN_SENTENCE_PERIOD = /(?<![0-9])\.(?=\s|$)/;
  var JP_COMMA = /、/;
  var EN_SENTENCE_COMMA = /(?<=[ぁ-んァ-ヿ一-龥①-⑳]),(?!\d)/;

  function commaSpacingMatchText(text, commaPos) {
    var stops = " \t\r\n,、，。．.()（）[]【】<>＜＞";
    var left = commaPos;
    while (left > 0 && stops.indexOf(text[left - 1]) < 0) left--;
    var right = commaPos + 1;
    while (right < text.length && stops.indexOf(text[right]) < 0) right++;
    left = Math.max(left, commaPos - 12);
    right = Math.min(right, commaPos + 13);
    return text.slice(left, right);
  }
  function checkCommaSpacing(text, result) {
    eachMatch(COMMA_NO_SPACE, text, function (m) {
      result.add({
        category: "記号", severity: SEVERITY_WARN, message: "「,」の後に半角スペースを入れる",
        snippet: commaSpacingMatchText(text, m.index),
        match_text: m[0], suggestion: "「, 」（カンマ＋半角スペース）",
      });
    });
  }
  function checkSpaceMix(text, result) {
    text.split("\n").forEach(function (line) {
      if (line.indexOf(" ") >= 0 && line.indexOf("　") >= 0) {
        result.add({
          category: "記号", severity: SEVERITY_WARN,
          message: "半角スペース（ ）と全角スペース（　）が同一段落内に混在",
          snippet: truncate(line.trim(), 70),
          suggestion: "同一項目内では半角スペースまたは全角スペースに統一する",
        });
      }
    });
  }
  function checkMicroUnit(text, result) {
    eachMatch(MU_GREEK, text, function (m) {
      result.add({
        category: "記号", severity: SEVERITY_INFO,
        message: "ギリシャ文字「μ」（U+03BC）が使われている。マイクロサイン「µ」（U+00B5、半角）に統一する",
        snippet: snippet(text, m.index, m.index + m[0].length),
        match_text: m[0], suggestion: "µL, µg/dL など（半角µ）",
      });
    });
  }
  function checkBrackets(text, result) {
    eachMatch(UNUSUAL_BRACKETS, text, function (m) {
      result.add({
        category: "記号", severity: SEVERITY_INFO,
        message: "標準外の括弧「" + m[0] + "」が使われている",
        snippet: snippet(text, m.index, m.index + m[0].length),
        match_text: m[0], suggestion: "丸括弧 () または かぎ括弧 「」 を基本とする（セクション見出しは【】可）",
      });
    });
  }
  function checkPunctuationConsistency(text, result) {
    var jpPeriod = JP_PERIOD.exec(text);
    var enPeriod = new RegExp(EN_SENTENCE_PERIOD.source).exec(text);
    var jpComma = JP_COMMA.exec(text);
    var enComma = new RegExp(EN_SENTENCE_COMMA.source).exec(text);
    if (jpPeriod && enPeriod) {
      result.add({
        category: "記号", severity: SEVERITY_WARN,
        message: "句点が混在：「。」と「.」（ピリオド）の両方が使われている",
        snippet: snippet(text, enPeriod.index, enPeriod.index + enPeriod[0].length),
        match_text: enPeriod[0], suggestion: "同一レポート内で「。」または「.」に統一する",
      });
    }
    if (jpComma && enComma) {
      result.add({
        category: "記号", severity: SEVERITY_WARN,
        message: "読点が混在：「、」と「,」（カンマ）の両方が使われている",
        snippet: snippet(text, enComma.index, enComma.index + enComma[0].length),
        match_text: jpComma[0], suggestion: "同一レポート内で「、」または「,」に統一する",
      });
    }
  }

  // ==========================================================================
  // 検査名称（test_names.py）
  // ==========================================================================
  var IMG_TEST_NO_KENSA = /(?<![A-Za-z0-9ぁ-んァ-ヿ])(CT|MRI|MRA|MRV)(?![A-Za-z0-9]|検査|画像|所見|室)/g;
  var ECHO_NO_KENSA = /(エコー|超音波)(?!検査|画像|所見|室|域|輝度)/g;
  var RENTGEN = /レントゲン(?:写真)?/g;
  var XSEN_NO_KENSA = /X線(?!検査|画像|所見)/g;
  function checkTestName(text, result) {
    eachMatch(IMG_TEST_NO_KENSA, text, function (m) {
      result.add({
        category: "表記", severity: SEVERITY_INFO, message: "「" + m[1] + "」のあとに「検査」を付ける",
        snippet: snippet(text, m.index, m.index + m[0].length), match_text: m[0], suggestion: m[1] + "検査",
      });
    });
    eachMatch(ECHO_NO_KENSA, text, function (m) {
      result.add({
        category: "表記", severity: SEVERITY_INFO, message: "「" + m[1] + "」のあとに「検査」を付ける",
        snippet: snippet(text, m.index, m.index + m[0].length), match_text: m[0], suggestion: m[1] + "検査",
      });
    });
    eachMatch(RENTGEN, text, function (m) {
      result.add({
        category: "表記", severity: SEVERITY_INFO, message: "「レントゲン（写真）」は「X線検査」と表記する",
        snippet: snippet(text, m.index, m.index + m[0].length), match_text: m[0], suggestion: "X線検査",
      });
    });
    eachMatch(XSEN_NO_KENSA, text, function (m) {
      result.add({
        category: "表記", severity: SEVERITY_INFO, message: "「X線」のあとに「検査」を付ける（写真ではなく検査）",
        snippet: snippet(text, m.index, m.index + m[0].length), match_text: m[0], suggestion: "X線検査",
      });
    });
  }

  // ==========================================================================
  // 年齢呼称・読点（age.py: appellation / comma）
  // ==========================================================================
  var AGE_APPELLATION = /(?:生後|日齢)?\s*(\d+)\s*(歳|か月|ヶ月|日齢|週)(?:児|の)?\s*(新生児|乳児|男児|女児|男子|女子|男性|女性)/g;
  var AGE_WITH_COMMA = /(\d+)\s*(歳|か月|ヶ月)\s*[,、]\s*(男児|女児|男子|女子|男性|女性|新生児|乳児)/g;

  function appellationCategory(days) {
    if (days < 28) return ["新生児", "男児", "女児"];
    if (days < 365) return ["乳児", "男児", "女児"];
    if (days < 365 * 13) return ["男児", "女児"];
    if (days < 365 * 19) return ["男子", "女子"];
    return ["男性", "女性"];
  }
  function checkAgeAppellation(text, result) {
    eachMatch(AGE_APPELLATION, text, function (m) {
      var num = parseInt(m[1], 10);
      var unit = m[2];
      var app = m[3];
      var days;
      if (unit === "歳") days = num * 365;
      else if (unit === "か月" || unit === "ヶ月") days = num * 30;
      else if (unit === "日齢") days = num;
      else if (unit === "週") days = num * 7;
      else return;
      var expected = appellationCategory(days);
      if (expected.indexOf(app) < 0) {
        result.add({
          category: "表記", severity: SEVERITY_WARN,
          message: "「" + m[0] + "」: 年齢に対する呼称が不適切",
          snippet: snippet(text, m.index, m.index + m[0].length),
          match_text: m[0],
          suggestion: num + unit + "には「" + expected.slice().sort().join(" / ") + "」が適切",
        });
      }
    });
  }
  function checkAgeComma(text, result) {
    eachMatch(AGE_WITH_COMMA, text, function (m) {
      result.add({
        category: "表記", severity: SEVERITY_INFO, message: "年齢と呼称の間に読点（、・,）は不要",
        snippet: m[0], match_text: m[0],
        suggestion: m[1] + m[2] + m[3] + " （読点なしで連続）",
      });
    });
  }

  // ==========================================================================
  // 現症バイタルの記載順（vital_order.py）
  // ==========================================================================
  var VITAL_KEYWORDS = [
    ["身長", "身長"], ["体重", "体重"], ["体温", "体温"],
    ["呼吸数", "呼吸数"], ["脈拍数", "脈拍数?|心拍数"], ["血圧", "血圧"],
  ];
  var CURRENT_FINDINGS_HEADER = /【?(?:入院|来院|初診|受診|外来)時(?:身体|診察)?(?:所見|現症)】?/;
  function currentFindingsText(text) {
    var m = CURRENT_FINDINGS_HEADER.exec(text);
    if (m === null) return text;
    var rest = text.slice(m.index + m[0].length);
    var next = /\s*【[^】]+】/.exec(rest);
    if (next === null) return text.slice(m.index);
    return text.slice(m.index, m.index + m[0].length + next.index);
  }
  function checkVitalOrder(text, result) {
    var target = currentFindingsText(text);
    var positions = [];
    var rank = {};
    VITAL_KEYWORDS.forEach(function (kw, i) {
      rank[kw[0]] = i;
      var m = new RegExp(kw[1]).exec(target);
      if (m) positions.push([m.index, m.index + m[0].length, kw[0]]);
    });
    if (positions.length < 2) return;
    var ordered = positions.slice().sort(function (a, b) { return a[0] - b[0]; });
    var actualOrder = ordered.map(function (p) { return p[2]; });
    var ranks = actualOrder.map(function (n) { return rank[n]; });
    var bad = false;
    for (var i = 0; i < ranks.length - 1; i++) if (ranks[i] > ranks[i + 1]) bad = true;
    if (bad) {
      var start = ordered[0][0], end = ordered[ordered.length - 1][1];
      result.add({
        category: "記載順", severity: SEVERITY_INFO,
        message: "現症の記載順が推奨と異なる。現在: " + actualOrder.join(" → "),
        snippet: snippet(target, start, end, 35),
        match_text: target.slice(start, end),
        suggestion: "推奨: 身長 → 体重 → 体温 → 呼吸数 → 脈拍数 → 血圧",
      });
    }
  }

  // ==========================================================================
  // 検査の記載順（lab_order.py）
  // ==========================================================================
  var LAB_GROUPS = [
    ["尿検査", "[＜<【]?\\s*尿(?:定性|沈渣|検査)?\\s*[＞>】]?", "尿(?:検査|定性|沈渣|蛋白|糖|潜血|比重|pH)|U(?:rine)?[\\s_]*(?:protein|sugar)"],
    ["血球計算", "[＜<【]?\\s*(?:血算|血球計算|末梢血(?:液)?)\\s*[＞>】]?", "\\b(?:WBC|RBC|Hb|Ht|Plt|MCV|MCH|MCHC|MPV)\\b|白血球|赤血球|血小板|ヘモグロビン"],
    ["生化学", "[＜<【]?\\s*(?:生化学|血液生化学)\\s*[＞>】]?", "\\b(?:AST|ALT|LDH|γ-?GTP|GGT|Al-?P|ALP|TP|Alb|BUN|Cre|UN|Na|K|Cl|Ca|Mg|P|CRP|Glu|UA|T-?Bil|D-?Bil)\\b"],
  ];
  var LAB_FINDINGS_HEADER = /【(?:入院時)?検査(?:結果|所見|データ|成績)?】|^\s*(?:入院時)?検査(?:結果|所見|データ|成績)?[:：]/m;
  function labFindingsText(text) {
    var m = LAB_FINDINGS_HEADER.exec(text);
    if (m === null) return text;
    var rest = text.slice(m.index + m[0].length);
    var next = /\s*【[^】]+】/.exec(rest);
    if (next === null) return text.slice(m.index);
    return text.slice(m.index, m.index + m[0].length + next.index);
  }
  function labOrderMatchText(target, positions) {
    var labels = positions.map(function (p) { return target.slice(p[0], p[1]); });
    var allShort = labels.every(function (l) { return l.length <= 12; });
    if (allShort) {
      var joined = target.slice(positions[0][0], positions[positions.length - 1][1]);
      if (joined.length <= 80) return joined;
    }
    return labels[0];
  }
  function checkLabOrder(text, result) {
    var target = labFindingsText(text);
    var positions = [];
    var rank = {};
    LAB_GROUPS.forEach(function (g, i) {
      rank[g[0]] = i;
      var m = new RegExp(g[1]).exec(target);
      if (m === null) m = new RegExp(g[2]).exec(target);
      if (m) positions.push([m.index, m.index + m[0].length, g[0]]);
    });
    if (positions.length < 2) return;
    var ordered = positions.slice().sort(function (a, b) { return a[0] - b[0]; });
    var actualOrder = ordered.map(function (p) { return p[2]; });
    var ranks = actualOrder.map(function (n) { return rank[n]; });
    var bad = false;
    for (var i = 0; i < ranks.length - 1; i++) if (ranks[i] > ranks[i + 1]) bad = true;
    if (bad) {
      var start = ordered[0][0], end = ordered[ordered.length - 1][1];
      result.add({
        category: "記載順", severity: SEVERITY_INFO,
        message: "検査の記載順が推奨と異なる。現在: " + actualOrder.join(" → "),
        snippet: snippet(target, start, end, 35),
        match_text: labOrderMatchText(target, ordered),
        suggestion: "推奨: 尿検査 → 血球計算 → 生化学（侵襲の少ない順）",
      });
    }
  }

  // ==========================================================================
  // 家族歴（family_history.py）
  // ==========================================================================
  var FAMILY_HISTORY_BOILERPLATE = /^(?:特記(?:すべき)?(?:こと|事項|事)?(?:も)?(?:特に)?(?:は)?(?:な|無)し|特になし|なし|無し|ありません?)[\s。、,.]*$/;
  function checkFamilyHistory(caseObj, result) {
    var body = (caseObj.family_history || "").trim();
    if (!body) return;
    var flat = body.replace(/\s+/g, "");
    if (FAMILY_HISTORY_BOILERPLATE.test(flat)) {
      result.add({
        category: "記載内容", severity: SEVERITY_INFO,
        message: "家族歴が「特記すべきことなし」だけになっている",
        snippet: truncate(body, 60),
        suggestion: "妊娠経過・分娩歴・第N子・両親の既往など、書ける情報を盛り込む",
      });
    }
  }

  // ==========================================================================
  // 個人情報 PII（pii.py）
  // ==========================================================================
  var ABSOLUTE_DATE_RULES = [
    [/(?<!\d)(19|20)\d{2}[/\-.](0?[1-9]|1[0-2])[/\-.](0?[1-9]|[12]\d|3[01])(?!\d)/g, "具体的な日付（西暦）"],
    [/(?<!\d)(19|20)\d{2}\s*年\s*(0?[1-9]|1[0-2])\s*月(\s*(0?[1-9]|[12]\d|3[01])\s*日)?/g, "具体的な日付（西暦年月）"],
    [/(令和|平成|昭和|大正)\s*\d{1,2}\s*年(\s*\d{1,2}\s*月)?(\s*\d{1,2}\s*日)?/g, "具体的な日付（和暦）"],
    [/(?<!\d)(0?[1-9]|1[0-2])\s*月\s*(0?[1-9]|[12]\d|3[01])\s*日/g, "具体的な日付（月日）"],
  ];
  var KARTE_ID = /(?<![\d.])\d{7,}(?![\d.])/g;
  var LAB_UNIT_AFTER = /^\s*(\/|／|個|℃|mmHg|mg|g|mL|ml|IU|U|mEq|mmol|mol|μ|µ|ng|pg)/;
  var NAME_HONORIFIC = /([一-龥々]{2,4})(様|氏|さん|くん|ちゃん)/g;
  var NAME_EXCLUDE = ["患者", "母親", "父親", "本人", "家族", "医師", "看護"];

  function checkPii(text, result) {
    if (!text || !text.trim()) return;
    var acceptedSpans = [];
    ABSOLUTE_DATE_RULES.forEach(function (rule) {
      var re = rule[0], label = rule[1];
      eachMatch(re, text, function (m) {
        var s = m.index, e = m.index + m[0].length;
        var overlap = acceptedSpans.some(function (sp) { return s < sp[1] && sp[0] < e; });
        if (overlap) return;
        acceptedSpans.push([s, e]);
        result.add({
          category: "個人情報", severity: SEVERITY_ERROR,
          message: label + "が残っています。マスク版では伏字・相対表記にしてください",
          snippet: snippet(text, s, e), match_text: m[0],
          suggestion: "例: 「X年Y月Z日」「第5病日」「入院3日目」など",
        });
      });
    });
    eachMatch(KARTE_ID, text, function (m) {
      var after = text.slice(m.index + m[0].length, m.index + m[0].length + 8);
      if (LAB_UNIT_AFTER.test(after)) return;
      result.add({
        category: "個人情報", severity: SEVERITY_WARN,
        message: "カルテID等の数字列の可能性があります。マスク版に含めないでください",
        snippet: snippet(text, m.index, m.index + m[0].length), match_text: m[0],
        suggestion: "患者ID・カルテIDはWordに記載せずKIDSに入力してください",
      });
    });
    eachMatch(NAME_HONORIFIC, text, function (m) {
      if (NAME_EXCLUDE.indexOf(m[1]) >= 0) return;
      result.add({
        category: "個人情報", severity: SEVERITY_WARN,
        message: "氏名の可能性がある表現です。マスク版では氏名を記載しないでください",
        snippet: snippet(text, m.index, m.index + m[0].length), match_text: m[0],
        suggestion: "患者・家族の氏名は削除してください",
      });
    });
  }

  var MASKED_HEADER_FIELDS = [
    ["patient_id", "患者ID"], ["care_period", "受持期間"],
    ["patient_age", "患者年齢"], ["patient_sex", "患者性別"],
  ];
  var MASKED_REQUIRED_FIELDS = [["field_number", "分野番号"]];
  function checkMaskedHeader(caseObj, result) {
    MASKED_HEADER_FIELDS.forEach(function (f) {
      var value = (caseObj[f[0]] || "").trim();
      if (value) {
        result.add({
          category: "個人情報", severity: SEVERITY_ERROR,
          message: f[1] + " に実データが残っています。マスク版では空欄にしてください（KIDSに入力）",
          match_text: f[1], snippet: value.slice(0, 60),
        });
      }
    });
    MASKED_REQUIRED_FIELDS.forEach(function (f) {
      var value = (caseObj[f[0]] || "").trim();
      if (!value) {
        result.add({
          category: "記載漏れ", severity: SEVERITY_ERROR,
          message: f[1] + " が未記入です。スプレッドシート連携に必要なため必ず記入してください",
          match_text: f[1],
        });
      }
    });
  }

  // ==========================================================================
  // XML ユーティリティ（parser.py / *_check）
  // ==========================================================================
  function directChildren(el, localName) {
    var out = [];
    if (!el) return out;
    var ch = el.childNodes;
    for (var i = 0; i < ch.length; i++) {
      var n = ch[i];
      if (n.nodeType === 1 && n.namespaceURI === WORD_NS && n.localName === localName) out.push(n);
    }
    return out;
  }
  function descendants(el, localName) {
    // namespace対応の getElementsByTagNameNS。
    var list = el.getElementsByTagNameNS(WORD_NS, localName);
    var out = [];
    for (var i = 0; i < list.length; i++) out.push(list[i]);
    return out;
  }
  function wAttr(el, name) {
    if (!el) return null;
    return el.getAttributeNS(WORD_NS, name);
  }
  function cellText(tc) {
    var lines = [];
    directChildren(tc, "p").forEach(function (p) {
      var line = "";
      directChildren(p, "r").forEach(function (r) {
        directChildren(r, "t").forEach(function (t) { line += t.textContent; });
      });
      lines.push(line);
    });
    return lines.join("\n");
  }
  function stripLabel(text, label) {
    var body = (text || "").trim();
    var seps = [label + "：", label + ":", label];
    for (var i = 0; i < seps.length; i++) {
      if (body.indexOf(seps[i]) === 0) return body.slice(seps[i].length).trim();
    }
    return body;
  }
  var CHECK_MARKERS = ["✓", "✔", "☑", "✗", "＊", "●", "○"];
  function detectCheck(text, options) {
    var i, opt;
    for (i = 0; i < options.length; i++) {
      opt = options[i];
      if (new RegExp("■\\s*" + reEscape(opt)).test(text)) return opt;
    }
    for (var mi = 0; mi < CHECK_MARKERS.length; mi++) {
      for (i = 0; i < options.length; i++) {
        opt = options[i];
        if (new RegExp(reEscape(CHECK_MARKERS[mi]) + "\\s*" + reEscape(opt)).test(text)) return opt;
      }
    }
    for (i = 0; i < options.length; i++) {
      opt = options[i];
      if (text.indexOf(opt) >= 0 && text.indexOf("□" + opt) < 0 &&
          text.indexOf("□ " + opt) < 0 && text.indexOf("□　" + opt) < 0) return opt;
    }
    return "";
  }
  function rowCells(rowEl) { return directChildren(rowEl, "tc"); }

  function isTemplateTable(tableEl) {
    var rows = directChildren(tableEl, "tr");
    if (rows.length < 7) return false;
    var r0 = rowCells(rows[0]);
    if (r0.length < 1) return false;
    return cellText(r0[0]).trim() === "症例番号";
  }

  function parseCaseTable(tableIndex, tableEl) {
    var rows = directChildren(tableEl, "tr");
    var c = {
      table_index: tableIndex, case_number: "", field_number: "", admission_type: "",
      outcome: "", examiner_name: "", patient_id: "", care_period: "", patient_age: "",
      patient_sex: "", family_history: "", diagnosis: "", summary: "",
    };
    var r0 = rowCells(rows[0]);
    if (r0.length >= 6) {
      c.case_number = cellText(r0[1]).trim();
      c.field_number = cellText(r0[3]).trim();
      c.admission_type = detectCheck(cellText(r0[4]), ["入院症例", "外来症例"]);
      c.outcome = detectCheck(cellText(r0[5]), ["治癒", "軽快", "不変", "増悪", "死亡"]);
    }
    var r1 = rowCells(rows[1]);
    if (r1.length >= 4) {
      c.examiner_name = cellText(r1[1]).trim();
      c.patient_id = cellText(r1[3]).trim();
    }
    var r2 = rowCells(rows[2]);
    if (r2.length >= 2) {
      var periodRaw = cellText(r2[1]).trim();
      c.care_period = /\d/.test(periodRaw) ? periodRaw : "";
    }
    var r3 = rowCells(rows[3]);
    if (r3.length >= 4) {
      var ageRaw = cellText(r3[1]).trim();
      if (/\d/.test(ageRaw)) c.patient_age = ageRaw;
      c.patient_sex = detectCheck(cellText(r3[3]), ["男", "女"]);
    }
    var r4 = rowCells(rows[4]);
    if (r4.length) c.family_history = stripLabel(cellText(r4[0]), "家族歴、妊娠・分娩歴、既往歴");
    var r5 = rowCells(rows[5]);
    if (r5.length) c.diagnosis = stripLabel(cellText(r5[0]), "診断名");
    var r6 = rowCells(rows[6]);
    if (r6.length) c.summary = stripLabel(cellText(r6[0]), "症例要約");
    return c;
  }
  function isBlank(c) { return !((c.summary || "").trim() || (c.diagnosis || "").trim()); }

  // ==========================================================================
  // 書式（format_check.py）
  // ==========================================================================
  function runIsSubscript(rPr) {
    if (!rPr) return false;
    var vert = directChildren(rPr, "vertAlign")[0];
    if (!vert) return false;
    return wAttr(vert, "val") === "subscript";
  }
  function isMincho(name) {
    if (!name) return null;
    var lname = name.toLowerCase();
    if (lname.indexOf("mincho") >= 0 || name.indexOf("明朝") >= 0 || lname.indexOf("serif") >= 0) return true;
    if (lname.indexOf("gothic") >= 0 || name.indexOf("ゴシック") >= 0 || lname.indexOf("sans") >= 0 || lname.indexOf("meiryo") >= 0) return false;
    return null;
  }
  var STANDARD_SIZES = [10.5, 11.0];
  function collectInspectParagraphs(bodyEl, bodyTables) {
    if (bodyTables.length === 0) return descendants(bodyEl, "p");
    var first = bodyTables[0];
    if (!isTemplateTable(first)) return descendants(bodyEl, "p");
    var rows = directChildren(first, "tr");
    var targets = [];
    [4, 5, 6].forEach(function (ri) {
      if (ri >= rows.length) return;
      rowCells(rows[ri]).forEach(function (tc) {
        directChildren(tc, "p").forEach(function (p) { targets.push(p); });
      });
    });
    return targets;
  }
  function checkFormat(bodyEl, bodyTables, result) {
    var fontsJp = {};      // name -> snippet
    var fontsJpOrder = [];
    var fontsEn = {};
    var nonStdSize = [];   // [size, snippet]
    var seenSizePara = {};
    var formattedChars = []; // [ch, isSub]

    var paragraphs = collectInspectParagraphs(bodyEl, bodyTables);
    paragraphs.forEach(function (p) {
      var paraText = "";
      directChildren(p, "r").forEach(function (r) {
        directChildren(r, "t").forEach(function (t) { paraText += t.textContent || ""; });
      });
      var snippetText = truncate(paraText.replace(/\n/g, " ").trim(), 70);

      var paraSizes = {};
      directChildren(p, "r").forEach(function (r) {
        var rPr = directChildren(r, "rPr")[0];
        var runText = "";
        directChildren(r, "t").forEach(function (t) { runText += t.textContent || ""; });
        var isSub = runIsSubscript(rPr);
        for (var ci = 0; ci < runText.length; ci++) formattedChars.push([runText[ci], isSub]);
        if (!rPr) return;
        var sz = directChildren(rPr, "sz")[0];
        if (sz) {
          var val = wAttr(sz, "val");
          if (val) {
            var sizePt = parseInt(val, 10) / 2.0;
            if (STANDARD_SIZES.indexOf(sizePt) < 0) paraSizes[sizePt] = true;
          }
        }
        var rFonts = directChildren(rPr, "rFonts")[0];
        if (rFonts) {
          var ea = wAttr(rFonts, "eastAsia");
          if (ea && snippetText && !(ea in fontsJp)) { fontsJp[ea] = snippetText; fontsJpOrder.push(ea); }
          ["ascii", "hAnsi"].forEach(function (attr) {
            var en = wAttr(rFonts, attr);
            if (en) fontsEn[en] = true;
          });
        }
      });
      Object.keys(paraSizes).forEach(function (sizeStr) {
        if (!snippetText) return;
        var key = sizeStr + " " + snippetText;
        if (seenSizePara[key]) return;
        seenSizePara[key] = true;
        nonStdSize.push([parseFloat(sizeStr), snippetText]);
      });
    });

    nonStdSize.forEach(function (row) {
      result.add({
        category: "書式", severity: SEVERITY_INFO,
        message: pyFloat(row[0]) + "pt（標準は 10.5 もしくは 11pt）が使われています",
        snippet: row[1], suggestion: "該当箇所のフォントサイズを 10.5pt もしくは 11pt に揃える",
      });
    });
    fontsJpOrder.forEach(function (font) {
      if (isMincho(font)) return;
      result.add({
        category: "書式", severity: SEVERITY_INFO,
        message: "日本語フォントに明朝体以外が使われています: " + font,
        snippet: fontsJp[font], suggestion: "本文は明朝体（游明朝・ヒラギノ明朝など）が原則",
      });
    });
    var common = fontsJpOrder.filter(function (f) { return fontsEn[f]; }).sort();
    if (common.length) {
      result.add({
        category: "書式", severity: SEVERITY_INFO,
        message: "日本語と英数字で同じフォントが使われている: " + common.join(", "),
        suggestion: "日本語は明朝体（游明朝など）、英数字は Times New Roman などに分けて設定する",
      });
    }

    var fullText = formattedChars.map(function (x) { return x[0]; }).join("");
    var subRe = /\b(SpO|FIO|FiO|PaO|PaCO|HCO|NH)([0-9])\b/g;
    eachMatch(subRe, fullText, function (m) {
      var digitStart = m.index + m[1].length;
      var digitEnd = digitStart + m[2].length;
      var allSub = true;
      for (var i = digitStart; i < digitEnd; i++) {
        if (!formattedChars[i] || !formattedChars[i][1]) { allSub = false; break; }
      }
      if (allSub) return;
      result.add({
        category: "書式", severity: SEVERITY_WARN,
        message: "「" + m[0] + "」の数字を下付き文字で表記する",
        snippet: m[0], match_text: m[0], suggestion: m[1] + "<sub>" + m[2] + "</sub>",
      });
    });
  }

  // ==========================================================================
  // 分量（layout.py）
  // ==========================================================================
  var DEFAULT_CELL_WIDTH_PT = 482.0;
  var DEFAULT_FONT_SIZE_PT = 10.5;
  var MAX_LINES = 30;
  var MIN_LINES = 24;

  function summaryCellWidthPt(summaryTc) {
    var tcPr = directChildren(summaryTc, "tcPr")[0];
    if (!tcPr) return DEFAULT_CELL_WIDTH_PT;
    var tcW = directChildren(tcPr, "tcW")[0];
    if (!tcW) return DEFAULT_CELL_WIDTH_PT;
    var widthTwips = parseInt(wAttr(tcW, "w") || "0", 10);
    if (isNaN(widthTwips) || widthTwips <= 0) return DEFAULT_CELL_WIDTH_PT;
    return Math.max(100.0, (widthTwips - 216) / 20);
  }
  function dominantFontSizePt(summaryTc) {
    var sizes = {};
    descendants(summaryTc, "r").forEach(function (r) {
      var rPr = directChildren(r, "rPr")[0];
      if (!rPr) return;
      var sz = directChildren(rPr, "sz")[0];
      if (!sz) return;
      var val = wAttr(sz, "val");
      if (!val) return;
      var textLen = 0;
      descendants(r, "t").forEach(function (t) { textLen += (t.textContent || "").length; });
      if (textLen === 0) return;
      var pt = parseInt(val, 10) / 2.0;
      sizes[pt] = (sizes[pt] || 0) + textLen;
    });
    var keys = Object.keys(sizes);
    if (!keys.length) return DEFAULT_FONT_SIZE_PT;
    keys.sort(function (a, b) { return sizes[b] - sizes[a]; });
    return parseFloat(keys[0]);
  }
  function estimateSummaryLines(caseTableEl) {
    var rows = directChildren(caseTableEl, "tr");
    var summaryTc = rowCells(rows[6])[0];
    var cellWidthPt = summaryCellWidthPt(summaryTc);
    var fontSizePt = dominantFontSizePt(summaryTc);
    var charsPerLine = cellWidthPt / fontSizePt;

    var totalLines = 0;
    directChildren(summaryTc, "p").forEach(function (p) {
      var text = "";
      var explicitBreaks = 0;
      directChildren(p, "r").forEach(function (r) {
        var ch = r.childNodes;
        for (var i = 0; i < ch.length; i++) {
          var n = ch[i];
          if (n.nodeType === 1 && n.namespaceURI === WORD_NS) {
            if (n.localName === "t") text += n.textContent || "";
            else if (n.localName === "br") explicitBreaks += 1;
          }
        }
      });
      var stripped = text.trim();
      if (stripped === "症例要約") return;
      if (!stripped && explicitBreaks === 0) { totalLines += 1; return; }
      var visual = visualWidth(text);
      var wrap = Math.max(1, Math.ceil(visual / charsPerLine));
      totalLines += wrap + explicitBreaks;
    });
    return { estimated: totalLines, charsPerLine: charsPerLine, pt: fontSizePt };
  }
  function checkSummaryLayout(caseTableEl, result) {
    var rows = directChildren(caseTableEl, "tr");
    if (rows.length < 7) return;
    var est = estimateSummaryLines(caseTableEl);
    if (est.estimated > MAX_LINES) {
      result.add({
        category: "分量", severity: SEVERITY_ERROR,
        message: "症例要約が30行を超過する可能性があります（推定 " + est.estimated + " 行 / " +
          pyFloat(est.pt) + "pt × 約" + Math.round(est.charsPerLine) + "字/行で換算）",
        suggestion: "本文を圧縮するか、Word上で実際の行数を確認のうえ調整してください",
      });
    } else if (est.estimated < MIN_LINES) {
      var pct = Math.floor(est.estimated / MAX_LINES * 100);
      result.add({
        category: "分量", severity: SEVERITY_INFO,
        message: "症例要約欄の埋まり度が低い可能性があります（推定 " + est.estimated + "/30 行 = 約" + pct + "%）",
        suggestion: "80%（24行）以上を目安に内容を充実させてください",
      });
    }
  }

  // ==========================================================================
  // オーケストレーション（runner.py: run_checks masked）
  // ==========================================================================
  function checkCaseBody(caseObj, result) {
    if ((caseObj.summary || "").trim()) {
      var s = caseObj.summary;
      checkNgWords(s, result);
      checkKana(s, result);
      checkSpacing(s, result);
      checkAbbrev(s, result);
      checkPediatricDose(s, result);
      checkStructure(s, result, caseObj.admission_type);
      checkCommaSpacing(s, result);
      checkSpaceMix(s, result);
      checkMicroUnit(s, result);
      checkBrackets(s, result);
      checkPunctuationConsistency(s, result);
      checkTestName(s, result);
      checkAgeAppellation(s, result);
      checkAgeComma(s, result);
      checkVitalOrder(s, result);
      checkLabOrder(s, result);
      checkPii(s, result);
    }
    if ((caseObj.diagnosis || "").trim()) {
      checkNgWords(caseObj.diagnosis, result);
      checkAbbrev(caseObj.diagnosis, result);
      checkPii(caseObj.diagnosis, result);
    }
    if ((caseObj.family_history || "").trim()) {
      checkNgWords(caseObj.family_history, result);
      checkKana(caseObj.family_history, result);
      checkFamilyHistory(caseObj, result);
      checkPii(caseObj.family_history, result);
    }
  }

  // テキストルールのみ（XML不要）。テスト・簡易用途向け。
  function runMaskedOnCase(caseObj) {
    var result = new Result();
    checkMaskedHeader(caseObj, result);
    checkCaseBody(caseObj, result);
    return result.issues;
  }

  function bodyParagraphsText(bodyEl) {
    var lines = [];
    descendants(bodyEl, "p").forEach(function (p) {
      var text = "";
      directChildren(p, "r").forEach(function (r) {
        directChildren(r, "t").forEach(function (t) { text += t.textContent || ""; });
      });
      if (text.trim()) lines.push(text);
    });
    return lines.join("\n");
  }

  function runChecksMasked(bodyEl, bodyTables) {
    var result = new Result();
    var templateOk = bodyTables.length > 0 && isTemplateTable(bodyTables[0]);

    if (templateOk) {
      // 全 case テーブルを抽出（table_index は全テーブル中の位置）
      var cases = [];
      bodyTables.forEach(function (tbl, idx) {
        if (isTemplateTable(tbl)) cases.push(parseCaseTable(idx, tbl));
      });
      var filled = cases.filter(function (c) { return !isBlank(c); });

      if (!filled.length) {
        result.add({
          category: "入力", severity: SEVERITY_ERROR,
          message: "このファイルには記入済みの症例が見当たりません",
          suggestion: "テンプレートに症例情報を記入してから再度アップロードしてください",
        });
        checkFormat(bodyEl, bodyTables, result);
        return { result: result, caseObj: null, templateOk: templateOk };
      }
      if (filled.length > 1) {
        var labels = filled.map(function (c) { return "症例" + (c.case_number || (c.table_index + 1)); }).join(", ");
        result.add({
          category: "入力", severity: SEVERITY_WARN,
          message: "このファイルに記入された症例が複数あります（" + labels + "）。最初の症例のみをチェックします",
          suggestion: "1ファイルにつき1症例に分けて提出してください",
        });
      }
      var caseObj = filled[0];
      result.caseObj = caseObj;
      checkMaskedHeader(caseObj, result);
      checkCaseBody(caseObj, result);
      var caseTableEl = bodyTables[caseObj.table_index];
      if (caseTableEl && directChildren(caseTableEl, "tr").length >= 7) {
        checkSummaryLayout(caseTableEl, result);
      }
      checkFormat(bodyEl, bodyTables, result);
      return { result: result, caseObj: caseObj, templateOk: templateOk };
    }

    // 非テンプレート
    var text = bodyParagraphsText(bodyEl);
    checkNgWords(text, result);
    checkKana(text, result);
    checkSpacing(text, result);
    checkAbbrev(text, result);
    checkPediatricDose(text, result);
    checkStructure(text, result, "");
    checkPii(text, result);
    checkFormat(bodyEl, bodyTables, result);
    return { result: result, caseObj: null, templateOk: templateOk };
  }

  function parseDocumentXml(xml) {
    var doc = new DOMParser().parseFromString(xml, "application/xml");
    var errs = doc.getElementsByTagName("parsererror");
    if (errs && errs.length) throw new Error("document.xml の解析に失敗しました");
    return doc;
  }

  async function check(arrayBuffer) {
    try {
      var zip = await JSZip.loadAsync(arrayBuffer);
      var docFile = zip.file("word/document.xml");
      if (!docFile) return { case: null, findings: [], templateOk: false, error: "word/document.xml が見つかりません（.docxではない可能性）" };
      var xml = await docFile.async("string");
      var doc = parseDocumentXml(xml);
      var root = doc.documentElement;
      var body = directChildren(root, "body")[0];
      if (!body) return { case: null, findings: [], templateOk: false, error: "本文（body）が見つかりません" };
      var bodyTables = directChildren(body, "tbl");
      var out = runChecksMasked(body, bodyTables);
      return { case: out.caseObj, findings: out.result.issues, templateOk: out.templateOk, error: null };
    } catch (e) {
      return { case: null, findings: [], templateOk: false, error: (e && e.message) ? e.message : String(e) };
    }
  }

  var API = {
    check: check,
    runMaskedOnCase: runMaskedOnCase,
    checkPii: checkPii,
    SEVERITY_ERROR: SEVERITY_ERROR,
    SEVERITY_WARN: SEVERITY_WARN,
    SEVERITY_INFO: SEVERITY_INFO,
    // テスト用に内部関数も一部公開
    _internal: {
      parseCaseTable: parseCaseTable, isTemplateTable: isTemplateTable,
      runChecksMasked: runChecksMasked, directChildren: directChildren,
      parseDocumentXml: parseDocumentXml,
    },
  };

  if (typeof module !== "undefined" && module.exports) module.exports = API;
  global.Checker = API;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
