/* 雨锡的默写本 —— 主逻辑 */
(function () {
  "use strict";

  /* ---------- 工具 ---------- */
  function $(s, r) { return (r || document).querySelector(s); }
  function today() { return new Date().toISOString().slice(0, 10); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  // 拼音 a -> ɑ（棍棒体），保留声调
  function toA(s) {
    return String(s)
      .replace(/ā/g, "ɑ\u0304")
      .replace(/á/g, "ɑ\u0301")
      .replace(/ǎ/g, "ɑ\u030C")
      .replace(/à/g, "ɑ\u0300")
      .replace(/a/g, "ɑ");
  }
  function py(p) { return toA(p); }
  function pySpan(p) { return p ? '<span class="pinyin">' + py(p) + "</span>" : ""; }

  /* ---------- 遗忘曲线复习（间隔复习法） ---------- */
  // 每通过一次复习，下次复习间隔拉长；再次写错则回到第 1 天。
  var REVIEW_INTERVALS = [1, 2, 4, 7, 15, 30]; // 单位：天
  var REVIEW_MAX_STAGE = REVIEW_INTERVALS.length - 1;

  function addDays(dateStr, n) {
    var p = dateStr.split("-");
    var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  function daysBetween(a, b) {
    var pa = a.split("-"), pb = b.split("-");
    var da = Date.UTC(+pa[0], +pa[1] - 1, +pa[2]);
    var db = Date.UTC(+pb[0], +pb[1] - 1, +pb[2]);
    return Math.round((db - da) / 86400000);
  }

  /* ---------- 存储 ---------- */
  var LS = { custom: "yuxi_custom_v1", records: "yuxi_records_v1", mastered: "yuxi_mastered_v1", hidden: "yuxi_hidden_v1", review: "yuxi_review_v1", photos: "yuxi_photos_v1" };
  function load(k, d) { try { var v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } }
  function save(k, v) { localStorage.setItem(k, JSON.stringify(v)); }

  var customWords = load(LS.custom, []);
  var records = load(LS.records, []);
  var mastered = load(LS.mastered, {});
  var hidden = load(LS.hidden, {});
  var reviewState = load(LS.review, {}); // { 词: {stage, due, lastWrong, lastReview, count} }
  var photos = load(LS.photos, {});      // { 词: dataURL(压缩后的照片) }

  var MODE_LABEL = { tingxie: "听写练习", pin2word: "看拼音写词", word2pin: "看词写拼音", manual: "手动录入", review: "智能复习", wrong: "错词复习" };

  // 手动录入 / 练习页临时状态
  var showManual = false;
  var manualType = null;
  var pendingPhoto = null;

  function allWords() { return WORD_BANK.concat(customWords); }

  /* ---------- TTS（女播音员音色：优先系统里的高品质声音，清晰、有亲和力） ---------- */
  var _voice = null, _voiceReady = false;
  // 知名中文女声候选（按清晰度/亲和力排序，越靠前越优先）
  var _GOOD_VOICES = [
    "Ting-Ting", "Tingting", "婷婷",                 // Apple 普通话女声
    "Xiaoxiao", "晓晓",                               // 微软 / Edge 女声
    "Yu-shu", "Mei-Jia", "Meijia", "美佳",            // Apple
    "Yaoyao", "瑶瑶", "Huihui", "慧慧", "Lili", "晓伊",
    "Google 普通话", "Google"
  ];
  var _MALE_RE = /kangkang|康康|yun-?xi|云希|liang|亮|yunyang|male|男/i;
  function pickVoice() {
    try {
      var vs = window.speechSynthesis.getVoices() || [];
      if (!vs.length) return null;
      var zh = vs.filter(function (v) { return /zh|cmn|Chinese/i.test(v.lang || "") || /zh|cmn|Chinese|普通话/i.test(v.name || ""); });
      var pool = zh.length ? zh : vs;
      // 综合评分：高品质标记 > 知名女声 > 大陆普通话 > 女性 > 本地声音
      function score(v) {
        var n = v.name || "", s = 0;
        if (/premium|enhanced|elite|siri|优质|增强|高级/i.test(n)) s += 120;  // 高品质音色（听感最自然）
        if (_MALE_RE.test(n)) s -= 200;                                       // 避开男声
        for (var i = 0; i < _GOOD_VOICES.length; i++) {
          if (n.indexOf(_GOOD_VOICES[i]) >= 0) { s += 60 - i; break; }
        }
        if (/zh[-_]?(cn|cmn|hans)/i.test(v.lang || "")) s += 40;              // 大陆普通话优先
        else if (/^zh/i.test(v.lang || "")) s += 10;
        if (/female|女/i.test(n)) s += 15;
        if (v.localService) s += 5;                                           // 本地声音：响应快、离线可用
        return s;
      }
      pool.sort(function (a, b) { return score(b) - score(a); });
      return pool[0];
    } catch (e) { return null; }
  }
  function speak(text, rate) {
    if (!("speechSynthesis" in window) || !text) return;
    try {
      if (!_voiceReady) { _voice = pickVoice(); _voiceReady = true; }
      window.speechSynthesis.cancel();
      var u = new SpeechSynthesisUtterance(text);
      u.lang = "zh-CN";
      u.rate = rate || 0.85;   // 报词语速 0.92→0.85：更慢、读得更清楚
      u.pitch = 1.05;          // 音调微扬，更亲切
      u.volume = 1;
      if (_voice) u.voice = _voice;
      window.speechSynthesis.speak(u);
    } catch (e) {}
  }
  if ("speechSynthesis" in window) {
    window.speechSynthesis.onvoiceschanged = function () { _voice = pickVoice(); _voiceReady = true; };
  }

  /* ---------- 拼音自动生成（离线优先；按需加载，不拖慢首屏） ---------- */
  var _pyQueue = null, _pyState = 0; // 0=未加载 1=加载中 2=就绪
  function loadPinyinLib(cb) {
    if (window.pinyinPro && window.pinyinPro.pinyin) { _pyState = 2; if (cb) cb(); return; }
    if (cb) (_pyQueue = _pyQueue || []).push(cb);
    if (_pyState === 1) return;
    _pyState = 1;
    var s = document.createElement("script");
    s.src = "vendor/pinyin-pro.js";
    s.onload = s.onerror = function () {
      _pyState = (window.pinyinPro && window.pinyinPro.pinyin) ? 2 : 0;
      var q = _pyQueue || []; _pyQueue = null;
      q.forEach(function (f) { try { f(); } catch (e) {} });
    };
    document.head.appendChild(s);
  }
  // 同步取用：库已就绪才有结果，否则返回 ""（用于保存时兜底）
  function pinyinNow(word) {
    if (!word || !window.pinyinPro || !window.pinyinPro.pinyin) return "";
    try {
      return String(window.pinyinPro.pinyin(word, { toneType: "symbol", type: "string" }) || "")
        .replace(/\s+/g, " ").trim();
    } catch (e) { return ""; }
  }
  // 异步取用：需要时自动加载库
  function autoPinyin(word, cb) {
    var v = pinyinNow(word);
    if (v) return cb(v);
    if (!word) return cb("");
    loadPinyinLib(function () { cb(pinyinNow(word)); });
  }

  /* ---------- 聚合 ---------- */
  function aggregateWrong() {
    var map = {};
    records.forEach(function (r) {
      r.items.forEach(function (it) {
        if (it.correct) return;
        var w = it.word;
        if (!map[w]) map[w] = { word: w, pinyin: it.pinyin, count: 0, last: r.date, types: {} };
        map[w].count++;
        if (r.date > map[w].last) map[w].last = r.date;
        (it.wrongChars || []).forEach(function (c) { if (c.type) map[w].types[c.type] = (map[w].types[c.type] || 0) + 1; });
      });
    });
    return Object.keys(map).map(function (k) { return map[k]; })
      .filter(function (w) { return !mastered[w.word] && !hidden[w.word]; })
      .sort(function (a, b) { return b.count - a.count || (b.last < a.last ? -1 : 1); });
  }

  // 错词本完整列表：保留已标记的“已掌握”词（只是隐藏，不删除），仅排除“暂时隐藏”的词。
  function wrongBookList() {
    var map = {};
    records.forEach(function (r) {
      r.items.forEach(function (it) {
        if (it.correct) return;
        var w = it.word;
        if (!map[w]) map[w] = { word: w, pinyin: it.pinyin, count: 0, last: r.date, types: {} };
        map[w].count++;
        if (r.date > map[w].last) map[w].last = r.date;
        (it.wrongChars || []).forEach(function (c) { if (c.type) map[w].types[c.type] = (map[w].types[c.type] || 0) + 1; });
      });
    });
    return Object.keys(map).map(function (k) { return map[k]; })
      .filter(function (w) { return !hidden[w.word]; })
      .sort(function (a, b) { return (b.count - a.count) || (b.last < a.last ? -1 : 1); });
  }

  function attrTotals() {
    var t = {};
    records.forEach(function (r) {
      r.items.forEach(function (it) { if (!it.correct && it.type) t[it.type] = (t[it.type] || 0) + 1; });
    });
    return t;
  }

  /* ---------- 遗忘曲线：状态同步与抽词 ---------- */
  // 把错词本里还没有复习状态的词初始化（用最近一次出错日期作为起点）。
  function ensureReviewState() {
    aggregateWrong().forEach(function (w) {
      if (!reviewState[w.word]) {
        reviewState[w.word] = { stage: 0, due: addDays(w.last, REVIEW_INTERVALS[0]), lastWrong: w.last, lastReview: null, count: 0 };
      }
    });
  }
  function dueWords() {
    ensureReviewState();
    return aggregateWrong().filter(function (w) {
      var st = reviewState[w.word];
      return st && st.due <= today();
    });
  }
  function dueCount() { return dueWords().length; }
  function reviewInfo(word) {
    var st = reviewState[word];
    if (!st) return "";
    if (st.due <= today()) return "🔔 今天该复习";
    var d = daysBetween(today(), st.due);
    return "下次复习 " + st.due + "（还有 " + d + " 天）";
  }

  /* ---------- 练习状态 ---------- */
  var practice = null;

  function pickWords(scope, count) {
    var pool;
    if (scope === "review") {
      pool = dueWords().map(function (w) { return { word: w.word, pinyin: w.pinyin }; });
    } else if (scope === "wrong") {
      pool = aggregateWrong().map(function (w) { return { word: w.word, pinyin: w.pinyin }; });
    } else if (scope === "all") {
      pool = allWords().map(function (w) { return { word: w.word, pinyin: w.pinyin }; });
    } else {
      pool = allWords().filter(function (w) { return String(w.unit) === scope; })
        .map(function (w) { return { word: w.word, pinyin: w.pinyin }; });
    }
    pool = shuffle(pool.slice());
    if (count && count < pool.length) pool = pool.slice(0, count);
    return pool;
  }

  /* ---------- 渲染：路由 ---------- */
  var view = $("#view");
  var modal = $("#modal");
  var currentTab = "dash";
  var tabBeforePractice = "practice"; // 进入练习前所在的 tab，退出练习时回到这里

  function setTab(tab) {
    currentTab = tab;
    document.querySelectorAll(".tab").forEach(function (b) {
      b.classList.toggle("active", b.dataset.tab === tab);
    });
    render();
  }

  function render() {
    if (currentTab === "practice") return renderPractice();
    if (currentTab === "bank") return renderBank();
    if (currentTab === "wrong") return renderWrong();
    if (currentTab === "dash") return renderDash();
    if (currentTab === "records") return renderRecords();
  }

  /* ---------- 练习：设置 / 出题 / 批改 ---------- */
  function renderPractice() {
    if (!practice) return renderSetup();
    if (practice.phase === "quiz") return renderQuiz();
    if (practice.phase === "review") return renderReview();
  }

  // 不同练习方式下的“作答形式”标签
  function formLabels(mode) {
    if (mode === "pin2word") return ["本子书写", "在线书写"];
    if (mode === "word2pin") return ["本子作答", "在线作答"];
    return ["本子听写", "在线听写"];
  }

  function renderSetup() {
    var due = dueWords();

    var unitOpts = "";
    for (var u = 1; u <= 8; u++) unitOpts += '<option value="' + u + '">第一单元至第八单元·单元' + u + "</option>";
    unitOpts = '<option value="review">🔔 智能抽词（今日待复习 ' + due.length + '）</option>' +
               '<option value="wrong">🔁 仅错词本（复习）</option>' +
               '<option value="all">📚 全部单元</option>' + unitOpts;
    var m = (practice && practice.mode) || "tingxie";
    var modeSeg =
      '<div class="seg" id="modeSeg">' +
      '<button data-mode="tingxie" class="' + (m === "tingxie" ? "on" : "") + '">🔊 听写练习</button>' +
      '<button data-mode="pin2word" class="' + (m === "pin2word" ? "on" : "") + '">📝 看拼音写词</button>' +
      '<button data-mode="word2pin" class="' + (m === "word2pin" ? "on" : "") + '">🔤 看词写拼音</button>' +
      "</div>";
    var fl = formLabels(m);
    var formSeg =
      '<div class="seg" id="formSeg">' +
      '<button data-form="paper" class="' + (lastForm === "paper" ? "on" : "") + '">📝 ' + fl[0] + '</button>' +
      '<button data-form="online" class="' + (lastForm === "online" ? "on" : "") + '">💻 ' + fl[1] + '</button>' +
      "</div>";

    view.innerHTML =
      '<div class="card">' +
      '<div class="section-title">✏️ 新的一次练习</div>' +
      '<p class="muted">孩子纸面默写，家长事后在 APP 里批改、标错字、选归因。</p>' +
      '<label class="field"><span>练习方式</span>' + modeSeg + "</label>" +
      '<label class="field"><span>作答形式</span>' + formSeg + "</label>" +
      '<label class="field"><span>词语范围</span><select id="scopeSel">' + unitOpts + "</select></label>" +
      '<label class="field"><span>本次词数（留空或 0 = 全部）</span>' +
      '<input id="countInput" type="number" min="1" placeholder="例如 10" /></label>' +
      '<button class="btn primary block" data-act="start">开始练习 →</button>' +
      "</div>";
  }
  // 看词写拼音 · 四选一：干扰项按「一年级拼音易错点」从正确答案直接变换生成
  function toneless(s) {
    return String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, "").toLowerCase();
  }
  var _INITS = ["zh", "ch", "sh", "b", "p", "m", "f", "d", "t", "n", "l", "g", "k", "h", "j", "q", "x", "r", "z", "c", "s", "y", "w"];
  function parseSyl(s) {
    s = toneless(s);
    for (var k = 0; k < _INITS.length; k++) {
      if (s.indexOf(_INITS[k]) === 0) return { ini: _INITS[k], fin: s.slice(_INITS[k].length) };
    }
    return { ini: "", fin: s };
  }
  // 拼音相近度：同音节(声调不同)＋声母/韵母相同 计分，越接近分越高（干扰项不够时兜底用）
  function pinyinSim(a, b) {
    var as = a.split(" "), bs = b.split(" "), total = 0;
    for (var i = 0; i < as.length; i++) {
      var ap = parseSyl(as[i]), best = 0;
      for (var j = 0; j < bs.length; j++) {
        var bp = parseSyl(bs[j]), sc = 0;
        if (toneless(as[i]) === toneless(bs[j])) sc = 10;
        else { if (ap.ini && ap.ini === bp.ini) sc += 4; if (ap.fin && ap.fin === bp.fin) sc += 3; }
        if (sc > best) best = sc;
      }
      total += best;
    }
    return total;
  }

  // ---- 拼音音节拆装（声调/ü 处理）----
  var TONE_MARK = { "\u0304": 1, "\u0301": 2, "\u030C": 3, "\u0300": 4 };
  function sylParse(s) { // "xuě" -> {base:"xue", tone:3}；ü 记作 v
    var n = String(s).normalize("NFD"), tone = 0, base = "";
    for (var i = 0; i < n.length; i++) {
      var c = n[i];
      if (TONE_MARK[c]) { tone = TONE_MARK[c]; continue; }
      if (c === "\u0308") { base = base.replace(/u$/, "v"); continue; } // ü 记作 v（NFD 中两点挂在 u 后）
      base += c;
    }
    return { base: base, tone: tone };
  }
  function sylBuild(p) { // {base:"xue", tone:3} -> "xuě"（按标调规则落调号；ü 先落调再展开，避免组合顺序错乱）
    var mk = ["", "\u0304", "\u0301", "\u030C", "\u0300"][p.tone] || "";
    var b = p.base;
    if (!mk) return b.replace(/v/g, "u\u0308").normalize("NFC");
    var idx = -1;
    if (b.indexOf("a") >= 0) idx = b.indexOf("a");
    else if (b.indexOf("o") >= 0) idx = b.indexOf("o");
    else if (b.indexOf("e") >= 0) idx = b.indexOf("e");
    else { for (var i = b.length - 1; i >= 0; i--) if ("iuv".indexOf(b[i]) >= 0) { idx = i; break; } }
    var out2;
    if (idx < 0) out2 = b + mk;
    else out2 = b.slice(0, idx + 1) + mk + b.slice(idx + 1);
    return out2.replace(/v/g, "u\u0308").normalize("NFC");
  }

  // ---- 一年级拼音易错点 ----
  var ZCS = { zh: "z", z: "zh", ch: "c", c: "ch", sh: "s", s: "sh" };                 // 平翘舌不分
  var CONF = { b: ["d", "p"], d: ["b", "t"], t: ["d"], p: ["b", "q"], q: ["p"], n: ["l"], l: ["n"] }; // 形近声母看反
  var NASAL = { in: "ing", ing: "in", en: "eng", eng: "en", an: "ang", ang: "an" };  // 前后鼻音
  function sylVariants(base) { // 单音节的结构性易错变换（不含声调）
    var outs = [], pr = parseSyl(base), ini = pr.ini, fin = pr.fin;
    function push(nb) { if (nb && outs.indexOf(nb) < 0) outs.push(nb); }
    if (ZCS[ini]) push(base.replace(ini, ZCS[ini]));                                     // 平翘舌
    (CONF[ini] || []).forEach(function (x) { push(base.replace(ini, x)); });             // d/t、b/p 等
    Object.keys(NASAL).forEach(function (k) {                                            // 前后鼻音
      if (fin.slice(-k.length) === k) push(base.slice(0, base.length - k.length) + NASAL[k]);
    });
    // u 上两点加不加（j q x y l n + u）
    if (/^[jqxyln]$/.test(ini) && fin.indexOf("u") === 0) push(base.slice(0, ini.length) + "v" + fin.slice(1));
    return outs;
  }
  function pinyinConfusions(tp) { // 整词易错干扰项：结构变换优先，声调变换其次
    var syls = tp.split(" "), struct = [], tones = [];
    function add(list, cand) { if (cand && cand !== tp && list.indexOf(cand) < 0) list.push(cand); }
    syls.forEach(function (s, si) {
      var p = sylParse(s);
      sylVariants(p.base).forEach(function (nb) {
        var cand = syls.slice(); cand[si] = sylBuild({ base: nb, tone: p.tone });
        add(struct, cand.join(" "));
      });
    });
    syls.forEach(function (s, si) { // 声调标错
      var p = sylParse(s);
      if (!p.tone) return;
      [1, 2, 3, 4].forEach(function (t) {
        if (t === p.tone) return;
        var cand = syls.slice(); cand[si] = sylBuild({ base: p.base, tone: t });
        add(tones, cand.join(" "));
      });
    });
    return struct.concat(tones);
  }
  function buildMcq(target) {
    var tp = target.pinyin;
    var picks = shuffle(pinyinConfusions(tp)).slice(0, 3); // 易错变换优先
    if (picks.length < 3) { // 不足再按“拼音相近”从词库补
      var pool = allWords().filter(function (x) { return x.pinyin !== tp; });
      var scored = pool.map(function (x) { return { p: x.pinyin, score: pinyinSim(tp, x.pinyin) }; });
      scored.sort(function (m, n) { return n.score - m.score; });
      for (var k = 0; k < scored.length && picks.length < 3; k++) {
        if (picks.indexOf(scored[k].p) < 0) picks.push(scored[k].p);
      }
    }
    return shuffle([tp].concat(picks));
  }

  function renderQuiz() {
    destroyQuizWriters();
    if (practice.form === "online" && practice.mode !== "word2pin") return renderOnlineQuiz();
    var i = practice.idx;
    var w = practice.words[i];
    var total = practice.words.length;
    var revealed = practice.revealed[i];

    var promptHtml = "";
    if (practice.mode === "tingxie") {
      promptHtml =
        '<button class="btn primary read-btn" data-act="read">🔊 读词</button>' +
        '<p class="muted">点“读词”报给孩子听写；下方可在需要时显示答案。</p>' +
        (revealed ? '<div class="big-word">' + esc(w.word) + '</div><div class="pinyin">' + py(w.pinyin) + "</div>" : "");
    } else if (practice.mode === "pin2word") {
      promptHtml =
        '<div class="big-pinyin">' + py(w.pinyin) + "</div>" +
        (revealed ? '<div class="big-word">' + esc(w.word) + "</div>" : '<p class="muted">孩子看拼音写词语，写完后点“显示词语”核对。</p>');
    } else if (practice.mode === "word2pin" && practice.form === "online") {
      // 看词写拼音 · 在线作答 → 四选一（4 个按一年级易错点生成的混淆拼音）
      if (!practice._mcq) practice._mcq = {};
      if (!practice._mcq[i]) practice._mcq[i] = { options: buildMcq(w), answer: w.pinyin, chosen: null, correct: null };
      var mc = practice._mcq[i];
      var optsHtml = mc.options.map(function (op) {
        var cls = "btn mcq" + (mc.chosen === op ? (mc.correct ? " ok" : " bad") : "");
        return '<button class="' + cls + '" data-act="mcq" data-op="' + esc(op) + '">' + py(op) + "</button>";
      }).join("");
      promptHtml =
        '<div class="big-word">' + esc(w.word) + "</div>" +
        '<div class="muted" style="margin:8px 0 6px">选出发音正确的拼音：</div>' +
        '<div class="mcq-grid">' + optsHtml + "</div>" +
        (mc.chosen ? (mc.correct ? '<p class="ok-tip">✅ 答对啦！</p>' : '<p class="bad-tip">❌ 正确答案是：' + py(mc.answer) + "</p>") : "");
    } else {
      // 看词写拼音 · 本子作答 → 与其他本子模式一致：看词写在本子上，家长批改
      promptHtml =
        '<div class="big-word">' + esc(w.word) + "</div>" +
        (revealed ? '<div class="big-pinyin">' + py(w.pinyin) + "</div>"
          : '<p class="muted">孩子看词语，在练习本上写出拼音；写完后点“显示拼音”核对。</p>');
    }

    var pct = Math.round((i + 1) / total * 100);
    view.innerHTML =
      '<div class="card quiz-stage">' +
      '<div class="quiz-topbar">' +
      '<button class="icon-btn" data-act="exit">✕ 退出练习</button>' +
      '<div class="quiz-index">第 ' + (i + 1) + " / " + total + " 题</div>" +
      "</div>" +
      '<div class="quiz-prog">' +
      '<div class="quiz-prog-row"><span class="quiz-prog-label">完成进度</span><span class="quiz-prog-pct">' + pct + "%</span></div>" +
      '<div class="prog"><div class="prog-fill" style="width:' + pct + '%"></div></div>' +
      "</div>" +
      promptHtml +
      ((practice.mode === "word2pin" && practice.form === "online") ? "" :
        '<div class="row" style="justify-content:center;margin-top:18px">' +
        '<button class="btn ghost" data-act="reveal">' + (revealed ? "隐藏答案" : "显示答案") + "</button></div>") +
      "</div>" +
      '<div class="row between" style="margin-top:8px">' +
      '<button class="btn" data-act="prev" ' + (i === 0 ? "disabled" : "") + ">← 上一个</button>" +
      (i === total - 1
        ? '<button class="btn primary" data-act="toreview">去批改 ✅</button>'
        : '<button class="btn primary" data-act="next">下一个 →</button>') +
      "</div>";
  }

  function renderReview() {
    var rows = practice.words.map(function (w, i) {
      var r = practice.results[i] || { correct: true, wrongChars: [], type: null };
      var chars = w.word.split("").map(function (ch, ci) {
        var on = r.wrongChars.some(function (x) { return x.char === ch && x.idx === ci; });
        return '<div class="char-cell ' + (on ? "on" : "") + '" data-act="wc" data-i="' + i + '" data-ci="' + ci + '" data-ch="' + esc(ch) + '">' + esc(ch) + "</div>";
      }).join("");
      var seg = '<div class="seg" data-attr="' + i + '">' + ATTR_TYPES.map(function (t) {
        return '<button data-act="attr" data-i="' + i + '" data-k="' + t.key + '" class="' + (r.type === t.key ? "on" : "") + '">' + t.label + "</button>";
      }).join("") + "</div>";

      var detail = r.correct ? "" :
        '<div style="margin-top:10px">' +
        '<div class="muted" style="margin-bottom:4px">点选出错的字：</div>' +
        '<div class="char-grid">' + chars + "</div>" +
        '<div class="muted" style="margin:8px 0 4px">错在哪？</div>' + seg +
        "</div>";

      return '<div class="review-item ' + (r.correct ? "" : "wrong") + '">' +
        '<div class="review-head">' +
        '<div><span class="list-word">' + esc(w.word) + '</span> ' + pySpan(w.pinyin) + "</div>" +
        '<div class="judge">' +
        '<button class="btn yes ' + (r.correct ? "on" : "") + '" data-act="judge" data-i="' + i + '" data-v="1">对 ✓</button>' +
        '<button class="btn no ' + (!r.correct ? "on" : "") + '" data-act="judge" data-i="' + i + '" data-v="0">错 ✗</button>' +
        "</div></div>" + detail + "</div>";
    }).join("");

    view.innerHTML =
      '<div class="grade-bar">' +
      '<button class="icon-btn" data-act="back">← 返回</button>' +
      '<div class="grade-title">🔍 家长批改</div>' +
      '<button class="icon-btn save" data-act="save">💾 保存</button>' +
      "</div>" +
      '<div class="card"><p class="muted">逐词标记对错；错的字点选出来，并选择归因类型。</p></div>' +
      rows;
  }

  /* ---------- 词语库 ---------- */
  function computeUnits() {
    var units = {};
    allWords().forEach(function (w) { (units[w.unit] = units[w.unit] || []).push(w); });
    var keys = Object.keys(units).sort(function (a, b) { return a - b; });
    return { units: units, keys: keys };
  }

  function bankListHtml(units, keys, q, unit) {
    var out = "";
    keys.forEach(function (k) {
      if (unit && String(k) !== String(unit)) return;
      var list = units[k].filter(function (w) {
        if (!q) return true;
        var s = (w.word + " " + w.pinyin + " " + (w.lesson || "")).toLowerCase();
        return s.indexOf(q.toLowerCase()) >= 0;
      });
      if (!list.length) return;
      out += '<div style="margin:10px 0 4px;font-weight:700">单元' + k + "（" + list.length + "）</div>";
      list.forEach(function (w) {
        var isCustom = customWords.indexOf(w) >= 0;
        out += '<div class="list-row clickable" data-act="wstroke" data-w="' + esc(w.word) + '" data-p="' + esc(w.pinyin) + '">' +
          '<div><span class="list-word">' + esc(w.word) + '</span> <span class="pinyin">' + py(w.pinyin) + "</span>" +
          '<div class="unit-tag">' + esc(w.lesson || "") + "</div></div>" +
          (isCustom ? '<button class="del" data-act="delword" data-w="' + esc(w.word) + '">删除</button>' : "") +
          "</div>";
      });
    });
    return out || '<p class="muted">没有匹配的词语。</p>';
  }

  function renderBank() {
    var cu = computeUnits();
    var q = (window.__bankQ || "");
    var unit = (window.__bankUnit || "");

    var html = '<div class="card">' +
      '<div class="section-title">➕ 添加自定义词语</div>' +
      '<label class="field"><span>词语</span><input id="nw" type="text" placeholder="例如：彩虹" /></label>' +
      '<label class="field"><span>拼音（自动生成）</span><input id="np" type="text" placeholder="输入词语后自动填好，无需手填" /></label>' +
      '<div class="hint" style="margin:-4px 0 10px">拼音会自动生成；多音字如有出入，可直接改。</div>' +
      '<div class="row">' +
      '<label class="field" style="flex:1"><span>单元</span><input id="nu" type="number" min="1" value="1" /></label>' +
      '<label class="field" style="flex:2"><span>课文/来源</span><input id="nl" type="text" placeholder="可选" /></label>' +
      "</div>" +
      '<button class="btn primary block" data-act="addword">添加</button>' +
      "</div>";

    var unitOpts = '<option value="">全部单元</option>';
    for (var u = 1; u <= 8; u++) {
      unitOpts += '<option value="' + u + '"' + (String(u) === String(unit) ? " selected" : "") + ">第 " + u + " 单元</option>";
    }

    html += '<div class="card"><div class="section-title">📚 词语表（统编版二年级上册 · 示例）</div>';
    html += '<div class="bank-filter">' +
      '<select id="bankUnit">' + unitOpts + '</select>' +
      '<input id="bankSearch" type="text" placeholder="搜索词语 / 拼音 / 课文" value="' + esc(q) + '" />' +
      '</div>';
    html += '<div id="bankList">' + bankListHtml(cu.units, cu.keys, q, unit) + "</div></div>";
    view.innerHTML = html;

    // 输入词语 → 自动生成拼音（拼音库按需加载；异步结果回来时若词语已改则不覆盖）
    var nwEl = $("#nw"), npEl = $("#np");
    if (nwEl && npEl) {
      loadPinyinLib();
      nwEl.addEventListener("input", function () {
        var v = nwEl.value.trim();
        autoPinyin(v, function (py) { if (nwEl.value.trim() === v) npEl.value = py; });
      });
    }
  }

  /* ---------- 错词本 ---------- */
  function manualFormHtml() {
    var seg = '<div class="seg" id="mType">' + ATTR_TYPES.map(function (t) {
      return '<button data-act="mtype" data-k="' + t.key + '" class="' + (manualType === t.key ? "on" : "") + '">' + t.label + "</button>";
    }).join("") + "</div>";
    return '<div class="card manual-form">' +
      '<div class="section-title">✍️ 手动添加错词</div>' +
      '<p class="muted">把纸面默写拍下来或填进来，直接进错词本，按遗忘曲线复习。</p>' +
      '<label class="field"><span>词语</span><input id="mw" type="text" placeholder="例如：彩虹" /></label>' +
      '<label class="field"><span>错在哪（可选）</span>' + seg + "</label>" +
      '<div class="field"><span class="field-label">照片（拍照或相册，二选一，可选）</span>' +
      '<div class="seg" id="mPhotoMode">' +
      '<button type="button" data-act="mcamera">📷 拍照</button>' +
      '<button type="button" data-act="malbum">🖼️ 从相册选</button>' +
      '</div>' +
      '<input type="file" id="mPhoto" accept="image/*" style="display:none" />' +
      '<div id="mPhotoPrev" class="photo-prev"></div>' +
      '<div class="hint">照片仅保存在本机，不上传任何云端。</div>' +
      '</div>' +
      '<label class="field"><span>备注（可选）</span><input id="mn" type="text" placeholder="例如：和“红”混淆" /></label>' +
      '<div class="row between">' +
      '<button class="btn ghost" data-act="cancelmanual">取消</button>' +
      '<button class="btn primary" data-act="manualsave">保存到错词本</button>' +
      "</div></div>";
  }

  function renderWrong() {
    var list = filterByCat(wrongBookList(), wrongCat, wrongCause);
    if (!list.length) {
      view.innerHTML = '<div class="card empty">🎉 还没有错词！<br/>去"词语听写"做几次默写，或点下方手动添加。</div>' +
        (showManual ? manualFormHtml() : '<button class="btn primary block" data-act="toggelmanual" style="margin-top:10px">➕ 手动添加错词</button>');
      return;
    }
    var due = dueWords().length;
    var rows = list.map(function (w) {
      var types = Object.keys(w.types).map(function (k) { return ATTR_LABEL[k]; }).join("、");
      var st = reviewState[w.word];
      var stageTxt = st && st.count ? " · 已复习 " + st.count + " 次" : "";
      var reviewMsg = reviewInfo(w.word);
      var isMastered = !!mastered[w.word];
      return '<div class="wb-item">' +
        '<div><span class="wb-word clickable" data-act="wstroke" data-w="' + esc(w.word) + '" data-p="' + esc(w.pinyin) + '" title="点我看笔顺田字格">' + esc(w.word) + '</span> <span class="pinyin">' + py(w.pinyin) + "</span>" +
        '<div class="unit-tag">出错 ' + w.count + " 次 · 最近 " + w.last + stageTxt + "</div>" +
        (reviewMsg ? '<div class="unit-tag review-hint">' + reviewMsg + "</div>" : "") +
        (isMastered ? '<div class="unit-tag" style="color:var(--green);font-weight:700">⭐ 已掌握（练习时自动跳过）</div>' : "") +
        (types ? '<div class="unit-tag">归因：' + types + "</div>" : "") +
        (photos[w.word] ? '<img class="wb-photo" src="' + photos[w.word] + '" style="display:block;margin-top:6px" />' : "") +
        "</div>" +
        '<div class="row">' +
        (isMastered
          ? '<button class="btn green" style="padding:8px 12px;font-size:14px" data-act="unmaster" data-w="' + esc(w.word) + '" title="取消已掌握">⭐ 已掌握</button>'
          : '<button class="btn" style="padding:8px 12px;font-size:14px" data-act="master" data-w="' + esc(w.word) + '" title="标记为已掌握">标为已掌握</button>') +
        '<button class="btn danger" style="padding:8px 12px;font-size:14px" data-act="delwrong" data-w="' + esc(w.word) + '" title="彻底删除该错词">🗑️ 删除</button>' +
        '<button class="del" data-act="hide" data-w="' + esc(w.word) + '" title="暂时隐藏">隐藏</button>' +
        "</div></div>";
    }).join("");

    var manualBtn = '<button class="btn primary block" data-act="toggelmanual" style="margin-bottom:10px">' + (showManual ? "收起 ✕" : "➕ 手动添加错词") + "</button>";
    var manualForm = showManual ? manualFormHtml() : "";

    var wcatSeg = '<div class="seg" style="max-width:340px;margin-bottom:8px">' +
      '<button data-act="wrong-cat" data-cat="pinyin" class="' + (wrongCat === "pinyin" ? "on" : "") + '">拼音错</button>' +
      '<button data-act="wrong-cat" data-cat="word" class="' + (wrongCat === "word" ? "on" : "") + '">词语错</button>' +
      "</div>";
    var wcause = wrongCat === "word" ? causeChipsHtml(wrongCause, "wrong-cause") : "";

    view.innerHTML =
      manualBtn + manualForm +
      '<div class="card"><div class="section-title">❌ 错词本（' + list.length + "）</div>" +
      wcatSeg + wcause +
      (due ? '<button class="btn green block" data-act="smartreview" style="margin-bottom:10px">🔔 智能复习（今日待复习 ' + due + '）</button>' : "") +
      '<button class="btn primary block" data-act="reviewwrong" style="margin-bottom:10px">🔁 复习所有错词</button>' +
      '<div class="wb-grid">' + rows + "</div></div>";
  }

  /* ---------- 看板 ---------- */
  function renderDash() {
    var totalItems = 0;
    records.forEach(function (r) { totalItems += r.items.length; });
    var masteredCount = Object.keys(mastered).filter(function (k) { return mastered[k]; }).length;
    var due = dueWords();

    var catSeg = '<div class="seg" style="max-width:320px;margin-bottom:6px">' +
      '<button data-act="dash-cat" data-cat="pinyin" class="' + (dashCat === "pinyin" ? "on" : "") + '">拼音错</button>' +
      '<button data-act="dash-cat" data-cat="word" class="' + (dashCat === "word" ? "on" : "") + '">词语错</button>' +
      "</div>";
    var causeBox = dashCat === "word" ? causeChipsHtml(dashCause, "dash-cause") : "";

    var wrong = filterByCat(aggregateWrong(), dashCat, dashCause).slice(0, 10);
    var topHtml = wrong.length ? wrong.map(function (w, i) {
      return '<div class="list-row clickable" data-act="wstroke" data-w="' + esc(w.word) + '" data-p="' + esc(w.pinyin) + '"><span><b>' + (i + 1) + ".</b> " + esc(w.word) + ' <span class="pinyin">' + py(w.pinyin) + "</span></span>" +
        '<span class="badge red">' + w.count + " 次</span></div>";
    }).join("") : '<p class="muted">暂无高频错词。</p>';

    var pie = pieChart(attrTotals());

    view.innerHTML =
      '<div class="stat-grid">' +
      stat(records.length, "练习次数") +
      stat(totalItems, "累计默写词数") +
      stat(masteredCount, "已掌握错词", masteredCount ? "show-mastered" : null) +
      stat(due.length, "今日待复习", due.length ? "show-due" : null) +
      "</div>" +
      '<div class="card"><div class="section-title">🔝 高频错词 Top</div>' + catSeg + causeBox + topHtml + "</div>" +
      '<div class="card"><div class="section-title">🧩 错字归因分布</div>' + pie + "</div>";
  }

  function stat(num, lbl, act) {
    var cls = "stat" + (act ? " clickable" : "");
    var attr = act ? ' data-act="' + act + '"' : "";
    return '<div class="' + cls + '"' + attr + '><div class="num">' + num + '</div><div class="lbl">' + lbl + (act ? " →" : "") + "</div></div>";
  }

  // 查某个词的拼音（来自词库或历史记录）
  function pinyinOf(word) {
    var found = allWords().filter(function (w) { return w.word === word; })[0];
    if (found && found.pinyin) return found.pinyin;
    for (var i = 0; i < records.length; i++) {
      for (var j = 0; j < records[i].items.length; j++) {
        if (records[i].items[j].word === word && records[i].items[j].pinyin) return records[i].items[j].pinyin;
      }
    }
    return "";
  }

  // 词语卡片弹层
  function openWordModal(title, words, footerHtml) {
    $("#modalTitle").textContent = title;
    var body = words.map(function (w) {
      var info = "";
      if (mastered[w.word]) info = '<span class="badge green">⭐ 已掌握</span>';
      else {
        var st = reviewState[w.word];
        if (st) info = st.due <= today()
          ? '<span class="badge red">今天复习</span>'
          : '<span class="badge">' + (st.count ? "已复习 " + st.count + " 次" : "第 1 轮") + "</span>";
      }
      return '<div class="wcard"><div><span class="w-main">' + esc(w.word) + "</span> " + pySpan(w.pinyin) + "</div>" + info + "</div>";
    }).join("");
    $("#modalBody").innerHTML = body + (footerHtml || "");
    modal.classList.remove("hidden");
  }
  function closeModal() { destroyModalWriters(); modal.classList.add("hidden"); }

  /* ---------- 闯关记录（历史） ---------- */
  function renderRecords() {
    if (!records.length) {
      view.innerHTML = '<div class="card empty">📭 还没有闯关记录。<br/>去"词语听写"做几次，或手动添加错词，这里就会留下历史。</div>';
      return;
    }
    var sorted = records.slice().sort(function (a, b) { return b.id - a.id; });
    var html = '<div class="card"><div class="section-title">🏆 闯关记录</div>' +
      '<p class="muted">共 ' + records.length + ' 次练习，按时间倒序排列。</p></div>';
    html += sorted.map(function (r) {
      var total = r.items.length;
      var correct = r.items.filter(function (it) { return it.correct; }).length;
      var acc = total ? Math.round(correct / total * 100) : 0;
      var wrongs = r.items.filter(function (it) { return !it.correct; });
      var modeLabel = MODE_LABEL[r.mode] || r.mode;
      var detail = wrongs.length
        ? wrongs.map(function (it) {
            var ph = photos[it.word] ? '<img class="rec-photo" src="' + photos[it.word] + '">' : "";
            var tg = it.type ? '<span class="badge red">' + ATTR_LABEL[it.type] + "</span>" : "";
            return '<div class="rec-wrong"><span class="rec-word">' + esc(it.word) + '</span>' +
              " " + pySpan(it.pinyin) + tg + ph + "</div>";
          }).join("")
        : '<div class="rec-wrong"><span class="muted">全部正确，太棒了！🌟</span></div>';
      return '<div class="card rec">' +
        '<div class="rec-top"><div><div class="rec-date">' + r.date + '</div><div class="rec-mode">' + modeLabel + '</div></div>' +
        '<div class="rec-acc"><span class="num">' + acc + '%</span><span class="lbl">正确率</span></div></div>' +
        '<div class="rec-detail">' + detail +
        (r.note ? '<div class="rec-note">📝 ' + esc(r.note) + "</div>" : "") +
        '</div>' +
        '<div style="padding:0 16px 14px"><button class="del" data-act="delrec" data-id="' + r.id + '">删除这条记录</button></div>' +
        '</div>';
    }).join("");
    view.innerHTML = '<div class="rec-grid">' + html + "</div>";
  }

  function pieChart(totals) {
    var colors = { tone_same: "#5BC97A", shape_same: "#FF8A5B", stroke: "#FFC93C", pinyin: "#2BC4A8", unknown: "#9B6DD6" };
    var keys = Object.keys(totals);
    var sum = keys.reduce(function (a, k) { return a + totals[k]; }, 0);
    if (!sum) return '<p class="muted">暂无错字归因数据。</p>';
    var acc = 0, stops = [];
    keys.forEach(function (k) {
      var v = totals[k], start = acc / sum * 360; acc += v; var end = acc / sum * 360;
      stops.push(colors[k] + " " + start + "deg " + end + "deg");
    });
    var legend = keys.map(function (k) {
      return '<div><span class="dot" style="background:' + colors[k] + '"></span>' + ATTR_LABEL[k] + "：" + totals[k] + "</div>";
    }).join("");
    return '<div class="pie-wrap"><div class="pie" style="background:conic-gradient(' + stops.join(",") + ')"></div><div class="legend">' + legend + "</div></div>";
  }

  /* ---------- 交互（事件委托） ---------- */
  view.addEventListener("click", function (e) {
    var t = e.target.closest("[data-act]");
    if (!t) return;
    var act = t.dataset.act;

    if (act === "exit") { practice = null; setTab(tabBeforePractice || "practice"); return; }
    if (act === "back") { practice.phase = "quiz"; return renderQuiz(); }
    if (act === "toggelmanual") { showManual = !showManual; if (!showManual) { manualType = null; pendingPhoto = null; } return renderWrong(); }
    if (act === "cancelmanual") { showManual = false; manualType = null; pendingPhoto = null; return renderWrong(); }
    if (act === "mtype") {
      var mk = t.dataset.k;
      manualType = (manualType === mk) ? null : mk;
      var mseg = $("#mType");
      if (mseg) mseg.querySelectorAll("button").forEach(function (b) { b.classList.toggle("on", b.dataset.k === manualType); });
      return;
    }
    if (act === "mcamera" || act === "malbum") {
      var fi = $("#mPhoto"); if (!fi) return;
      if (act === "mcamera") fi.setAttribute("capture", "environment"); else fi.removeAttribute("capture");
      var pm = $("#mPhotoMode");
      if (pm) pm.querySelectorAll("button").forEach(function (b) { b.classList.toggle("on", b.dataset.act === act); });
      fi.click();
      return;
    }
    if (act === "manualsave") return doManualSave();
    if (act === "rmphoto") {
      pendingPhoto = null;
      var prev = $("#mPhotoPrev"); if (prev) prev.innerHTML = "";
      var minp = $("#mPhoto"); if (minp) minp.value = "";
      return;
    }
    if (act === "delrec") {
      var rid = +t.dataset.id;
      records = records.filter(function (r) { return r.id !== rid; });
      save(LS.records, records);
      toast("已删除该记录");
      return renderRecords();
    }

    if (act === "start") return doStart();
    if (act === "read") return speak(practice.words[practice.idx].word);
    if (act === "reveal") { practice.revealed[practice.idx] = !practice.revealed[practice.idx]; return renderQuiz(); }
    // 看词写拼音 · 在线作答：必须先选一个答案才能翻页
    if (act === "next") {
      if (practice.mode === "word2pin" && practice.form === "online" &&
          (!practice._mcq || !practice._mcq[practice.idx] || !practice._mcq[practice.idx].chosen))
        return toast("请先选一个拼音答案哦");
      if (practice.idx < practice.words.length - 1) { practice.idx++; renderQuiz(); }
      return;
    }
    if (act === "prev") { if (practice.idx > 0) { practice.idx--; renderQuiz(); } return; }
    if (act === "toreview") {
      if (practice.mode === "word2pin" && practice.form === "online" &&
          (!practice._mcq || !practice._mcq[practice.idx] || !practice._mcq[practice.idx].chosen))
        return toast("请先选一个拼音答案哦");
      practice.phase = "review"; return renderReview();
    }
    // 看词写拼音 → 四选一答题
    if (act === "mcq") {
      var op = t.dataset.op, mi = practice.idx;
      if (!practice._mcq) practice._mcq = {};
      if (!practice._mcq[mi]) practice._mcq[mi] = { options: buildMcq(practice.words[mi]), answer: practice.words[mi].pinyin, chosen: null, correct: null };
      var mc = practice._mcq[mi];
      if (mc.chosen) return; // 已作答，不再更改
      mc.chosen = op;
      mc.correct = (op === mc.answer);
      practice.results[mi] = { correct: mc.correct, wrongChars: mc.correct ? [] : [{ char: practice.words[mi].word, idx: 0, type: null }], type: null };
      return renderQuiz();
    }

    if (act === "judge") {
      var i = +t.dataset.i, v = t.dataset.v === "1";
      practice.results[i] = practice.results[i] || { correct: true, wrongChars: [], type: null };
      practice.results[i].correct = v;
      if (v) { practice.results[i].wrongChars = []; practice.results[i].type = null; }
      return renderReview();
    }
    if (act === "wc") {
      var i2 = +t.dataset.i, ci = +t.dataset.ci, ch = t.dataset.ch;
      var arr = practice.results[i2].wrongChars;
      var idx = arr.findIndex(function (x) { return x.char === ch && x.idx === ci; });
      if (idx >= 0) arr.splice(idx, 1); else arr.push({ char: ch, idx: ci, type: practice.results[i2].type });
      return renderReview();
    }
    if (act === "attr") {
      var i3 = +t.dataset.i, k = t.dataset.k;
      var res = practice.results[i3];
      res.type = (res.type === k) ? null : k;
      res.wrongChars.forEach(function (x) { x.type = res.type; });
      if (res.type && res.correct) { res.correct = false; }
      return renderReview();
    }
    if (act === "save") return doSave();

    // 看板 / 错词本：拼音错·词语错 分类切换 + 词语错错因筛选
    if (act === "dash-cat") { dashCat = t.dataset.cat; dashCause = ""; return renderDash(); }
    if (act === "dash-cause") { dashCause = t.dataset.k || ""; return renderDash(); }
    if (act === "wrong-cat") { wrongCat = t.dataset.cat; wrongCause = ""; return renderWrong(); }
    if (act === "wrong-cause") { wrongCause = t.dataset.k || ""; return renderWrong(); }

    // 点击词语 → 田字格笔顺卡片
    if (act === "wstroke") { openStrokeModal(t.dataset.w, t.dataset.p); return; }

    // 在线听写/书写：播放全部笔顺（显示答案并逐字、逐笔动画+口播，左→右依次播放）/ 完成本题
    if (act === "on-playall") {
      practice.revealed[practice.idx] = true;
      practice._play = true;
      return renderOnlineQuiz();
    }
    if (act === "on-done") { finishOnlineWord(); return; }

    if (act === "show-due") {
      openWordModal("🔔 今日待复习（" + dueWords().length + "）", dueWords(),
        '<button class="btn green block" data-act="modal-start-review" style="margin-top:6px">开始智能复习 →</button>');
      return;
    }
    if (act === "show-mastered") {
      var mw = Object.keys(mastered).filter(function (k) { return mastered[k]; })
        .map(function (k) { return { word: k, pinyin: pinyinOf(k) }; });
      openWordModal("⭐ 已掌握错词（" + mw.length + "）", mw);
      return;
    }

    if (act === "addword") return doAddWord();
    if (act === "delword") {
      var wname = t.dataset.w;
      customWords = customWords.filter(function (x) { return x.word !== wname; });
      save(LS.custom, customWords); toast("已删除"); return renderBank();
    }

    if (act === "delwrong") {
      var dw2 = t.dataset.w;
      if (!confirm("确定要彻底删除错词「" + dw2 + "」吗？\n该词会从错词本和练习记录里一并移除，且不可恢复。")) return;
      records.forEach(function (r) { r.items = r.items.filter(function (it) { return it.word !== dw2; }); });
      records = records.filter(function (r) { return r.items.length > 0; });
      save(LS.records, records);
      delete mastered[dw2]; save(LS.mastered, mastered);
      delete hidden[dw2]; save(LS.hidden, hidden);
      delete reviewState[dw2]; save(LS.review, reviewState);
      delete photos[dw2]; save(LS.photos, photos);
      toast("已删除错词：" + dw2);
      return renderWrong();
    }
    if (act === "hide") { hidden[t.dataset.w] = true; save(LS.hidden, hidden); delete reviewState[t.dataset.w]; save(LS.review, reviewState); toast("已隐藏"); return renderWrong(); }
    if (act === "master") {
      var mw = t.dataset.w;
      mastered[mw] = true; save(LS.mastered, mastered);
      toast("已标记为掌握 ⭐（仍保留在错词本，练习“错题本”时自动跳过）");
      return renderWrong();
    }
    if (act === "unmaster") {
      var uw = t.dataset.w;
      delete mastered[uw]; save(LS.mastered, mastered);
      if (!reviewState[uw]) {
        reviewState[uw] = { stage: 0, due: today(), lastWrong: today(), lastReview: null, count: 0 };
        save(LS.review, reviewState);
      }
      toast("已取消掌握，重新进入复习");
      return renderWrong();
    }
    if (act === "smartreview") {
      var dw = dueWords();
      if (!dw.length) return toast("今天没有待复习的词，雨锡真棒！🌟");
      practice = { mode: "tingxie", scope: "review", words: dw.map(function (w) { return { word: w.word, pinyin: w.pinyin }; }), idx: 0, phase: "quiz", revealed: {}, results: [] };
      return renderQuiz();
    }
    if (act === "reviewwrong") {
      if (!aggregateWrong().length) return toast("没有可复习的错词");
      practice = { mode: "tingxie", scope: "wrong", words: aggregateWrong().map(function (w) { return { word: w.word, pinyin: w.pinyin }; }), idx: 0, phase: "quiz", revealed: {}, results: [] };
      return renderQuiz();
    }
  });

  // 出题方式切换（重新渲染，使“作答形式”标签随方式更新）
  view.addEventListener("click", function (e) {
    var b = e.target.closest("#modeSeg button");
    if (!b) return;
    if (!practice) practice = blankPractice(b.dataset.mode);
    else practice.mode = b.dataset.mode;
    renderSetup();
  });

  // 听写形式切换（本子 / 在线）
  view.addEventListener("click", function (e) {
    var b = e.target.closest("#formSeg button");
    if (!b) return;
    lastForm = b.dataset.form;
    document.querySelectorAll("#formSeg button").forEach(function (x) { x.classList.toggle("on", x === b); });
  });

  // 词语库搜索（只刷新列表，保留输入框焦点）
  view.addEventListener("input", function (e) {
    if (e.target && e.target.id === "bankSearch") {
      window.__bankQ = e.target.value;
      var cu = computeUnits();
      var list = $("#bankList");
      if (list) list.innerHTML = bankListHtml(cu.units, cu.keys, window.__bankQ, window.__bankUnit || "");
    }
  });

  // 拍照 / 上传图片：压缩后暂存
  view.addEventListener("change", function (e) {
    if (e.target && e.target.id === "bankUnit") {
      window.__bankUnit = e.target.value;
      var cu = computeUnits();
      var list = $("#bankList");
      if (list) list.innerHTML = bankListHtml(cu.units, cu.keys, window.__bankQ || "", window.__bankUnit);
      return;
    }
    if (e.target && e.target.id === "mPhoto") {
      var f = e.target.files && e.target.files[0];
      if (!f) return;
      compressImage(f, function (d) {
        if (!d) { toast("图片读取失败"); return; }
        pendingPhoto = d;
        var prev = $("#mPhotoPrev");
        if (prev) prev.innerHTML = '<img class="ph-img" src="' + d + '"><br/><button class="del" data-act="rmphoto" style="margin-top:6px">移除照片</button>';
      });
    }
  });

  /* ---------- 弹层交互 ---------- */
  modal.addEventListener("click", function (e) {
    if (e.target === modal) { closeModal(); return; }
    var b = e.target.closest("[data-act]");
    if (!b) return;
    var a = b.dataset.act;
    if (a === "closemodal") { closeModal(); return; }
    if (a === "tian-play") {
      var wi = +b.dataset.i;
      // 逐笔动画演示 + 语音报笔画名（左→右单字，点哪个字播哪个字）
      if (modalWriters[wi]) revealWriter(modalWriters[wi], b.dataset.ch || "");
      return;
    }
    if (a === "modal-start-review") {
      closeModal();
      var dw = dueWords();
      if (!dw.length) { toast("今天没有待复习的词，雨锡真棒！🌟"); return; }
      practice = { mode: "tingxie", scope: "review", words: dw.map(function (w) { return { word: w.word, pinyin: w.pinyin }; }), idx: 0, phase: "quiz", revealed: {}, results: [] };
      renderQuiz();
    }
  });

  function blankPractice(mode) {
    return { mode: mode || "tingxie", scope: "all", words: [], idx: 0, phase: "quiz", revealed: {}, results: [] };
  }

  function doStart() {
    var scope = $("#scopeSel").value;
    var cnt = parseInt($("#countInput").value, 10);
    var words = pickWords(scope, (cnt && cnt > 0) ? cnt : 0);
    if (!words.length) { toast("该范围没有可用词语"); return; }
    tabBeforePractice = currentTab; // 记住来时的 tab，“退出练习”时回到这里
    practice = { mode: (practice && practice.mode) || "tingxie", scope: scope, form: lastForm, words: words, idx: 0, phase: "quiz", revealed: {}, results: [] };
    renderQuiz();
  }

  function doSave() {
    var items = practice.words.map(function (w, i) {
      var r = practice.results[i] || { correct: true, wrongChars: [], type: null };
      return { word: w.word, pinyin: w.pinyin, correct: r.correct, wrongChars: r.wrongChars, type: r.type };
    });
    records.push({ id: Date.now(), date: today(), mode: practice.mode, scope: practice.scope, items: items });

    // 更新遗忘曲线复习状态
    var wrongSet = {};
    aggregateWrong().forEach(function (w) { wrongSet[w.word] = true; });
    practice.words.forEach(function (w, i) {
      var r = practice.results[i] || { correct: true, wrongChars: [], type: null };
      var st = reviewState[w.word];
      if (r.correct) {
        if (st) { // 复习通过：进入下一轮，间隔拉长
          st.stage = Math.min(st.stage + 1, REVIEW_MAX_STAGE);
          st.lastReview = today();
          st.due = addDays(today(), REVIEW_INTERVALS[st.stage]);
          st.count++;
          if (st.stage === REVIEW_MAX_STAGE) { // 走完整个间隔周期 → 视为已掌握
            mastered[w.word] = true; save(LS.mastered, mastered);
            delete reviewState[w.word]; save(LS.review, reviewState);
          }
        }
      } else {
        if (!st) st = reviewState[w.word] = { stage: 0, due: addDays(today(), REVIEW_INTERVALS[0]), lastWrong: today(), lastReview: null, count: 0 };
        st.stage = 0;
        st.lastWrong = today();
        st.due = addDays(today(), REVIEW_INTERVALS[0]);
      }
    });

    save(LS.records, records);
    save(LS.review, reviewState);
    practice = null;
    toast("已保存，去「闯关记录」看看吧！🏆");
    setTab("records");
  }

  function doAddWord() {
    var word = $("#nw").value.trim();
    if (!word) { toast("请填写词语"); return; }
    var unit = parseInt($("#nu").value, 10) || 1;
    var lesson = $("#nl").value.trim();
    var typed = $("#np") ? $("#np").value.trim() : "";
    function commit(py) {
      customWords.push({ word: word, pinyin: py || "", unit: unit, lesson: lesson });
      save(LS.custom, customWords);
      toast(py ? "已添加：" + word : "已添加：" + word + "（拼音未生成，可稍后补）");
      renderBank();
    }
    if (typed) return commit(typed);   // 手动改过的按用户填的来
    autoPinyin(word, commit);          // 没填 → 自动生成，无需家长输入
  }

  /* 拍照上传：压缩到最大 640px 再存为 base64，避免撑爆 localStorage */
  function compressImage(file, cb) {
    var fr = new FileReader();
    fr.onload = function () {
      var img = new Image();
      img.onload = function () {
        var max = 640, w = img.width, h = img.height;
        if (w > h && w > max) { h = Math.round(h * max / w); w = max; }
        else if (h > max) { w = Math.round(w * max / h); h = max; }
        var c = document.createElement("canvas"); c.width = w; c.height = h;
        var ctx = c.getContext("2d"); ctx.drawImage(img, 0, 0, w, h);
        try { cb(c.toDataURL("image/jpeg", 0.8)); } catch (e) { cb(null); }
      };
      img.onerror = function () { cb(null); };
      img.src = fr.result;
    };
    fr.onerror = function () { cb(null); };
    fr.readAsDataURL(file);
  }

  function doManualSave() {
    var word = $("#mw").value.trim();
    if (!word) { toast("请填写词语"); return; }
    var pinyin = ($("#mp") ? $("#mp").value.trim() : "") || pinyinNow(word); // 未填则自动补拼音
    var note = $("#mn").value.trim();
    var type = manualType;
    records.push({ id: Date.now(), date: today(), mode: "manual", scope: "manual", items: [{ word: word, pinyin: pinyin, correct: false, wrongChars: [], type: type }], note: note });
    if (pendingPhoto) photos[word] = pendingPhoto;
    save(LS.records, records);
    save(LS.photos, photos);
    if (!reviewState[word]) reviewState[word] = { stage: 0, due: addDays(today(), REVIEW_INTERVALS[0]), lastWrong: today(), lastReview: null, count: 0 };
    save(LS.review, reviewState);
    showManual = false; manualType = null; pendingPhoto = null;
    toast("已加入错词本！🚀");
    renderWrong();
  }

  /* ---------- Toast ---------- */
  var toastTimer;
  function toast(msg) {
    var el = $("#toast");
    el.textContent = msg; el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove("show"); }, 1800);
  }

  /* ---------- Tab 绑定 ---------- */
  $("#tabBar").addEventListener("click", function (e) {
    var b = e.target.closest(".tab"); if (!b) return; setTab(b.dataset.tab);
  });

  /* ---------- 田字格 / 笔顺动画（HanziWriter，离线优先） ---------- */
  var _strokeCache = null;            // 本地 vendor/strokes.json（一次加载，离线可用）
  var _nameCache = null;              // 本地 vendor/stroke-names.json（逐笔标准笔画名，离线）
  var modalWriters = [];              // 弹层里的田字格实例
  var quizWriters = [];               // 在线听写时的田字格实例
  var lastForm = "paper";             // 听写形式：paper 本子 / online 在线

  // 词语错归因（不含“拼音错”），用于“词语错”的错因筛选
  var WORD_CAUSE_KEYS = ["tone_same", "shape_same", "stroke", "unknown"];
  var dashCat = "pinyin", dashCause = "";     // 看板高频错词分类状态
  var wrongCat = "pinyin", wrongCause = "";   // 错词本分类状态

  function isHanzi(c) { return c && c.charCodeAt(0) >= 0x4e00 && c.charCodeAt(0) <= 0x9fff; }

  // 统一的汉字数据加载器：先读本地合并包（离线），缺失再回退 CDN
  function HW_LOADER(char, onLoad) {
    function fromCDN() {
      fetch("https://cdn.jsdelivr.net/npm/hanzi-writer-data@2.0/" + encodeURIComponent(char) + ".json")
        .then(function (r) { return r.json(); }).then(onLoad).catch(function () { onLoad(null); });
    }
    if (_strokeCache) { if (_strokeCache[char]) onLoad(_strokeCache[char]); else fromCDN(); return; }
    fetch("vendor/strokes.json").then(function (r) { return r.json(); }).then(function (map) {
      _strokeCache = map;
      if (map[char]) onLoad(map[char]); else fromCDN();
    }).catch(function () { fromCDN(); });
  }
  // 预加载本地笔画库：确保首次进入听写即可口播笔画名，且全程离线可用
  fetch("vendor/strokes.json").then(function (r) { return r.json(); }).then(function (m) { _strokeCache = m; }).catch(function () {});
  // 预加载标准笔画名表（{字:[笔画名,...]}，按笔顺序，缺省项为空串=改用通用提示）
  fetch("vendor/stroke-names.json").then(function (r) { return r.json(); }).then(function (m) { _nameCache = m; }).catch(function () {});

  function makeWriter(el, ch) {
    if (!window.HanziWriter) { el.innerHTML = '<div class="tian-fallback">' + esc(ch) + "</div>"; return null; }
    try {
      return HanziWriter.create(el, ch, {
        width: 120, height: 120, padding: 8, showOutline: true, showCharacter: true,
        strokeColor: "#FF8A5B", radicalColor: "#2BC4A8",
        strokeAnimationSpeed: 0.7, delayBetweenStrokes: 260, charDataLoader: HW_LOADER
      });
    } catch (e) { el.innerHTML = '<div class="tian-fallback">' + esc(ch) + "</div>"; return null; }
  }

  // 在线书写：空白田字格 + 手写识别（HanziWriter quiz）。
  // 孩子每写对一笔即保留一笔；笔顺/笔画写错时，语音直接念出该笔的正确名称（不说“写错了…”），
  // 并由 HanziWriter 在该格中显示出“这一笔应该怎么写”（showHintAfterMisses: 1 = 错一次就提示）。
  function makeWriterQuiz(el, ch) {
    if (!window.HanziWriter) { el.innerHTML = ""; return null; } // 留白：仅保留 .tian 的米字格背景
    var w;
    try {
      w = HanziWriter.create(el, ch, {
        width: 120, height: 120, padding: 8, showOutline: false, showCharacter: false,
        strokeColor: "#FF8A5B", radicalColor: "#2BC4A8",
        strokeAnimationSpeed: 0.7, delayBetweenStrokes: 260, charDataLoader: HW_LOADER,
        leniency: 2.2,               // 放宽匹配阈值：大致画出来就算对，别挫败孩子
        highlightColor: "#3AA0FF",   // 笔顺提示高亮色：明显区别于孩子已写的珊瑚色
        strokeHighlightSpeed: 1.2,   // 提示动画稍慢，看得清
        highlightOnComplete: true,   // 整字写对后整体高亮，作为正反馈
        onMistake: function (strokeData, strokeNum) {
          var nm = strokeName(ch, strokeNum);
          if (nm) speak(nm, NAME_RATE); // 只念正确笔画名，不报“写错了…”
        }
      });
      w.quiz({ showHintAfterMisses: 1 }); // 写错 1 次即高亮提示该笔的正确写法
    } catch (e) { el.innerHTML = ""; return null; }
    return w;
  }
  var STROKE_DELAY = 340;   // 播放笔顺：两笔之间的停顿（毫秒），放慢便于跟写
  var NAME_RATE = 0.78;     // 报笔画名的语速（比报词更慢、更清楚）

  // 逐笔演示正确写法 + 语音报笔画名（女播音员音色，只念“横/竖/撇…”）；done 在该字全部笔画播完后回调
  function revealWriter(wr, ch, done) {
    if (!wr) { if (done) done(); return; }
    try { wr.hideCharacter(); } catch (e) {}
    var medians = (_strokeCache && _strokeCache[ch] && _strokeCache[ch].medians) || [];
    var n = medians.length, i = 0;
    if (!n) { // 笔画数据尚未就绪：退化为整字动画，保证仍能演示（此分支无口播）
      try { wr.animateCharacter().then(function () { if (done) done(); }); }
      catch (e) { if (done) done(); }
      return;
    }
    (function step() {
      if (i >= n) { if (done) done(); return; }
      var nm = strokeName(ch, i);
      if (nm) speak(nm, NAME_RATE); // 直接说笔画名字，不说“第几笔”
      try {
        wr.animateStroke(i).then(function () { i++; setTimeout(step, STROKE_DELAY); });
      } catch (e) { i++; setTimeout(step, STROKE_DELAY); }
    })();
  }
  // 多个字依次播放：先播左边，再播右边，不要同时播
  function playAllStrokes(wrs, chars) {
    var k = 0;
    (function next() {
      if (k >= wrs.length) return;
      var wr = wrs[k], ch = chars[k]; k++;
      revealWriter(wr, ch, next);
    })();
  }

  function destroyModalWriters() { modalWriters.forEach(function (w) { try { w.cancelQuiz && w.cancelQuiz(); } catch (e) {} }); modalWriters = []; }
  function destroyQuizWriters() { quizWriters.forEach(function (w) { try { w.cancelQuiz && w.cancelQuiz(); } catch (e) {} }); quizWriters = []; }

  // 笔画名：优先取本地标准笔画名表（逐笔精确、覆盖整个词库、离线可用）；
  // 表里没有（如自定义词）时退化为按中位点几何粗判基本笔画；仍无把握返回空串（改用通用提示）。
  function strokeName(ch, idx) {
    var nm = _nameCache && _nameCache[ch] && _nameCache[ch][idx];
    if (nm) return nm;
    if (_strokeCache && _strokeCache[ch] && _strokeCache[ch].medians && _strokeCache[ch].medians[idx]) {
      return classifyStroke(_strokeCache[ch].medians[idx]);
    }
    return "";
  }
  // 几何兜底：只对「基本笔画」有把握时才命名，复合笔画（折/钩/弯）一律留空避免误教。
  // 注意：hanzi-writer 数据 y 轴向上（y 增大 = 画面向上），故“竖”对应 dy<0。
  function classifyStroke(median) {
    if (!median || median.length < 2) return "";
    var a = median[0], b = median[median.length - 1];
    var dx = b[0] - a[0], dy = b[1] - a[1];
    var len = Math.hypot(dx, dy);
    if (len < 130) return "点";
    var adx = Math.abs(dx), ady = Math.abs(dy);
    var mi = median[Math.floor(median.length / 2)];
    var relDev = Math.abs((mi[0] - a[0]) * dy - (mi[1] - a[1]) * dx) / (len * len || 1);
    if (relDev > 0.40) return "";
    if (ady < adx * 0.28) return dx > 0 ? "横" : "撇";
    if (adx < ady * 0.30) return dy < 0 ? "竖" : "提";
    if (dx < 0 && dy < 0) return "撇";
    if (dx > 0 && dy < 0) return "捺";
    if (dx > 0 && dy > 0) return "提";
    return "";
  }

  // 词语卡片 → 田字格笔顺弹层
  function openStrokeModal(word, pinyin) {
    destroyModalWriters();
    $("#modalTitle").textContent = "✍️ " + word + " 笔顺";
    var chars = word.split("").filter(isHanzi);
    var html = '<div style="text-align:center;margin-bottom:6px">' + (pinyin ? pySpan(pinyin) : "") + "</div>";
    html += '<div class="tian-row">';
    chars.forEach(function (c, i) {
      html += '<div class="tian-cell"><div class="tian" id="tian-' + i + '"></div>' +
        '<button class="btn ghost tian-play" data-act="tian-play" data-i="' + i + '" data-ch="' + esc(c) + '" style="margin-top:6px;font-size:14px">▶ 笔顺</button></div>';
    });
    html += "</div><p class=\"muted\" style=\"text-align:center;margin-top:8px\">点“笔顺”播放，跟着写一写吧～</p>";
    $("#modalBody").innerHTML = html;
    modal.classList.remove("hidden");
    setTimeout(function () {
      chars.forEach(function (c, i) {
        var el = document.getElementById("tian-" + i);
        if (el) { var w = makeWriter(el, c); if (w) modalWriters.push(w); }
      });
    }, 30);
  }

  // 在线听写：田字格逐字描红
  function renderOnlineQuiz() {
    destroyQuizWriters();
    var i = practice.idx, w = practice.words[i], total = practice.words.length;
    var chars = w.word.split("").filter(isHanzi);
    var pct = Math.round((i + 1) / total * 100);
    var isPin = practice.mode === "pin2word";
    var cells = chars.map(function (c, ci) {
      return '<div class="tian-cell"><div class="tian" id="on-' + ci + '"></div></div>';
    }).join("");
    // 提示区：听写练习=报词+可读词；看拼音写词=只给拼音，不播音
    var promptHtml = isPin
      ? '<div class="big-pinyin">' + py(w.pinyin) + "</div>" +
        (practice.revealed[i] ? '<div class="big-word">' + esc(w.word) + '</div><div class="pinyin">' + py(w.pinyin) + "</div>"
          : '<p class="muted">看拼音，直接在田字格里手写；笔顺写错了会语音提示哦。</p>')
      : '<button class="btn primary read-btn" data-act="read">🔊 读词</button>' +
        '<p class="muted">听老师读词，直接在田字格里手写；笔顺写错了会语音提示哦。</p>' +
        (practice.revealed[i] ? '<div class="big-word">' + esc(w.word) + '</div><div class="pinyin">' + py(w.pinyin) + "</div>" : "");
    view.innerHTML =
      '<div class="card quiz-stage">' +
      '<div class="quiz-topbar"><button class="icon-btn" data-act="exit">✕ 退出练习</button>' +
      '<div class="quiz-index">第 ' + (i + 1) + " / " + total + " 题</div></div>" +
      '<div class="quiz-prog">' +
      '<div class="quiz-prog-row"><span class="quiz-prog-label">完成进度</span><span class="quiz-prog-pct">' + pct + "%</span></div>" +
      '<div class="prog"><div class="prog-fill" style="width:' + pct + '%"></div></div></div>' +
      promptHtml +
      '<div class="tian-row" id="onRow" style="justify-content:center;margin-top:10px">' + cells + "</div>" +
      '<div class="row" style="justify-content:center;gap:10px;margin-top:12px">' +
      '<button class="btn ghost" data-act="reveal">' + (practice.revealed[i] ? "隐藏答案" : "显示答案") + "</button>" +
      '<button class="btn ghost" data-act="on-playall">▶ 播放笔顺</button>' +
      '<button class="btn primary" data-act="on-done">完成本题 ✓</button>' +
      "</div></div>";
    setTimeout(function () {
      var wrs = [];
      chars.forEach(function (c, ci) {
        var el = document.getElementById("on-" + ci);
        if (el) { var wr = makeWriterQuiz(el, c); if (wr) wrs.push(wr); }
      });
      quizWriters = wrs;
      if (practice._play) {
        // 「播放笔顺」：逐字、逐笔动画演示 + 语音报笔画名（左→右依次播放，不同时播）
        practice._play = false;
        wrs.forEach(function (wr) { try { wr.cancelQuiz(); } catch (e) {} });
        playAllStrokes(wrs, chars);
      } else if (practice.revealed[i]) {
        // 「显示答案」：直接把汉字显示出来，不做笔顺动画、不播报
        wrs.forEach(function (wr) { try { wr.cancelQuiz(); wr.showCharacter(); } catch (e) {} });
      }
      // 否则保持 quiz() 手写状态：孩子直接在田字格里写，写错有提示
    }, 30);
  }

  function finishOnlineWord() {
    var i = practice.idx, w = practice.words[i];
    // 在线默写由孩子写在本子上，App 无法判定对错，结果留空，交给“批改”页人工勾选。
    practice.results[i] = { correct: true, wrongChars: [], type: null };
    destroyQuizWriters();
    if (i < practice.words.length - 1) { practice.idx++; renderQuiz(); }
    else { practice.phase = "review"; renderReview(); }
  }

  // 拼音错 / 词语错 分类
  // 规则：只要有“拼音错”归因就归入“拼音错”；其余（含只标错未选归因的词）一律归入“词语错”，
  // 保证每个错词都至少出现在一个分类里，不会凭空消失。
  function wordCat(w) {
    var pinyin = !!w.types["pinyin"];
    return { pinyin: pinyin, word: !pinyin };
  }
  function filterByCat(list, cat, cause) {
    return list.filter(function (w) {
      var c = wordCat(w);
      if (cat === "pinyin") return c.pinyin;
      // 词语错：归类到此的所有词；若指定错因则按错因筛选（错因里不含“拼音错”）
      if (cause) return !!w.types[cause];
      return c.word;
    });
  }
  function causeChipsHtml(active, act) {
    var chips = ['<button class="cause-chip ' + (active === "" ? "on" : "") + '" data-act="' + act + '" data-k="">全部</button>'];
    WORD_CAUSE_KEYS.forEach(function (k) {
      chips.push('<button class="cause-chip ' + (active === k ? "on" : "") + '" data-act="' + act + '" data-k="' + k + '">' + ATTR_LABEL[k] + "</button>");
    });
    return '<div class="cause-row">' + chips.join("") + "</div>";
  }

  /* ---------- 启动 ---------- */
  // 注意：Service Worker 的注册放在 index.html 末尾内联脚本里完成，
  // 这样即使浏览器缓存了旧版 app.js，也不会锁死 SW 版本（避免更新卡住）。
  setTab("dash");
})();
