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

  var MODE_LABEL = { tingxie: "听写报词", pin2word: "看拼音写词", word2pin: "看词写拼音", manual: "手动录入", review: "智能复习", wrong: "错词复习" };

  // 手动录入 / 练习页临时状态
  var showManual = false;
  var manualType = null;
  var pendingPhoto = null;

  function allWords() { return WORD_BANK.concat(customWords); }

  /* ---------- TTS ---------- */
  function speak(text) {
    if (!("speechSynthesis" in window)) return;
    try {
      speechSynthesis.cancel();
      var u = new SpeechSynthesisUtterance(text);
      u.lang = "zh-CN"; u.rate = 0.8; u.pitch = 1;
      speechSynthesis.speak(u);
    } catch (e) {}
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

  function renderSetup() {
    var due = dueWords();

    var unitOpts = "";
    for (var u = 1; u <= 8; u++) unitOpts += '<option value="' + u + '">第一单元至第八单元·单元' + u + "</option>";
    unitOpts = '<option value="review">🔔 智能抽词（今日待复习 ' + due.length + '）</option>' +
               '<option value="wrong">🔁 仅错词本（复习）</option>' +
               '<option value="all">📚 全部单元</option>' + unitOpts;
    var modeSeg =
      '<div class="seg" id="modeSeg">' +
      '<button data-mode="tingxie" class="on">🔊 听写(报词)</button>' +
      '<button data-mode="pin2word">看拼音写词</button>' +
      '<button data-mode="word2pin">看词写拼音</button>' +
      "</div>";

    view.innerHTML =
      '<div class="card">' +
      '<div class="section-title">✏️ 新的一次练习</div>' +
      '<p class="muted">孩子纸面默写，家长事后在 APP 里批改、标错字、选归因。</p>' +
      '<label class="field"><span>出题方式</span>' + modeSeg + "</label>" +
      '<label class="field"><span>词语范围</span><select id="scopeSel">' + unitOpts + "</select></label>" +
      '<label class="field"><span>本次词数（留空或 0 = 全部）</span>' +
      '<input id="countInput" type="number" min="1" placeholder="例如 10" /></label>' +
      '<button class="btn primary block" data-act="start">开始练习 →</button>' +
      "</div>";
  }

  function renderQuiz() {
    var i = practice.idx;
    var w = practice.words[i];
    var total = practice.words.length;
    var revealed = practice.revealed[i];

    var promptHtml = "";
    if (practice.mode === "tingxie") {
      promptHtml =
        '<button class="btn blue read-btn" data-act="read">🔊 读词</button>' +
        '<p class="muted">点“读词”报给孩子听写；下方可在需要时显示答案。</p>' +
        (revealed ? '<div class="big-word">' + esc(w.word) + '</div><div class="pinyin">' + py(w.pinyin) + "</div>" : "");
    } else if (practice.mode === "pin2word") {
      promptHtml =
        '<div class="big-pinyin">' + py(w.pinyin) + "</div>" +
        (revealed ? '<div class="big-word">' + esc(w.word) + "</div>" : '<p class="muted">孩子看拼音写词语，写完后点“显示词语”核对。</p>');
    } else {
      promptHtml =
        '<div class="big-word">' + esc(w.word) + "</div>" +
        (revealed ? '<div class="big-pinyin">' + py(w.pinyin) + "</div>" : '<p class="muted">孩子看词语写拼音，写完后点“显示拼音”核对。</p>');
    }

    view.innerHTML =
      '<div class="card quiz-stage">' +
      '<div class="quiz-topbar">' +
      '<button class="icon-btn" data-act="exit">✕ 退出练习</button>' +
      '<div class="quiz-index">第 ' + (i + 1) + " / " + total + "</div>" +
      "</div>" +
      '<div class="prog"><div class="prog-fill" style="width:' + Math.round((i + 1) / total * 100) + '%"></div></div>' +
      promptHtml +
      '<div class="row" style="justify-content:center;margin-top:18px">' +
      '<button class="btn ghost" data-act="reveal">' + (revealed ? "隐藏答案" : "显示答案") + "</button>" +
      "</div>" +
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
      rows +
      '<button class="btn green block" data-act="save" style="margin-top:6px">保存这次练习 💾</button>';
  }

  /* ---------- 词语库 ---------- */
  function computeUnits() {
    var units = {};
    allWords().forEach(function (w) { (units[w.unit] = units[w.unit] || []).push(w); });
    var keys = Object.keys(units).sort(function (a, b) { return a - b; });
    return { units: units, keys: keys };
  }

  function bankListHtml(units, keys, q) {
    var out = "";
    keys.forEach(function (k) {
      var list = units[k].filter(function (w) {
        if (!q) return true;
        var s = (w.word + " " + w.pinyin + " " + (w.lesson || "")).toLowerCase();
        return s.indexOf(q.toLowerCase()) >= 0;
      });
      if (!list.length) return;
      out += '<div style="margin:10px 0 4px;font-weight:700">单元' + k + "（" + list.length + "）</div>";
      list.forEach(function (w) {
        var isCustom = customWords.indexOf(w) >= 0;
        out += '<div class="list-row">' +
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

    var html = '<div class="card">' +
      '<div class="section-title">➕ 添加自定义词语</div>' +
      '<label class="field"><span>词语</span><input id="nw" type="text" placeholder="例如：彩虹" /></label>' +
      '<label class="field"><span>拼音（用普通 a 即可）</span><input id="np" type="text" placeholder="例如：cǎi hóng" /></label>' +
      '<div class="row">' +
      '<label class="field" style="flex:1"><span>单元</span><input id="nu" type="number" min="1" value="1" /></label>' +
      '<label class="field" style="flex:2"><span>课文/来源</span><input id="nl" type="text" placeholder="可选" /></label>' +
      "</div>" +
      '<button class="btn primary block" data-act="addword">添加</button>' +
      "</div>";

    html += '<div class="card"><div class="section-title">📚 词语表（统编版二年级上册 · 示例）</div>';
    html += '<input id="bankSearch" type="text" placeholder="搜索词语 / 拼音 / 课文" value="' + esc(q) + '" style="margin-bottom:10px" />';
    html += '<div id="bankList">' + bankListHtml(cu.units, cu.keys, q) + "</div></div>";
    view.innerHTML = html;
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
    var list = aggregateWrong();
    if (!list.length) {
      view.innerHTML = '<div class="card empty">🎉 还没有错词！<br/>去“去练习”做几次默写，或点下方手动添加。</div>' +
        (showManual ? manualFormHtml() : '<button class="btn blue block" data-act="toggelmanual" style="margin-top:10px">➕ 手动添加错词</button>');
      return;
    }
    var due = dueWords().length;
    var rows = list.map(function (w) {
      var types = Object.keys(w.types).map(function (k) { return ATTR_LABEL[k]; }).join("、");
      var st = reviewState[w.word];
      var stageTxt = st && st.count ? " · 已复习 " + st.count + " 次" : "";
      var reviewMsg = reviewInfo(w.word);
      return '<div class="wb-item">' +
        '<div><span class="wb-word">' + esc(w.word) + '</span> <span class="pinyin">' + py(w.pinyin) + "</span>" +
        '<div class="unit-tag">出错 ' + w.count + " 次 · 最近 " + w.last + stageTxt + "</div>" +
        (reviewMsg ? '<div class="unit-tag review-hint">' + reviewMsg + "</div>" : "") +
        (types ? '<div class="unit-tag">归因：' + types + "</div>" : "") +
        (photos[w.word] ? '<img class="wb-photo" src="' + photos[w.word] + '" style="display:block;margin-top:6px" />' : "") +
        "</div>" +
        '<div class="row">' +
        '<button class="btn danger" style="padding:8px 12px;font-size:14px" data-act="delwrong" data-w="' + esc(w.word) + '" title="彻底删除该错词">🗑️ 删除</button>' +
        '<button class="del" data-act="hide" data-w="' + esc(w.word) + '" title="暂时隐藏">隐藏</button>' +
        "</div></div>";
    }).join("");

    var manualBtn = '<button class="btn blue block" data-act="toggelmanual" style="margin-bottom:10px">' + (showManual ? "收起 ✕" : "➕ 手动添加错词") + "</button>";
    var manualForm = showManual ? manualFormHtml() : "";

    view.innerHTML =
      manualBtn + manualForm +
      '<div class="card"><div class="section-title">❌ 错词本（' + list.length + "）</div>" +
      (due ? '<button class="btn green block" data-act="smartreview" style="margin-bottom:10px">🔔 智能复习（今日待复习 ' + due + '）</button>' : "") +
      '<button class="btn blue block" data-act="reviewwrong" style="margin-bottom:10px">🔁 复习所有错词</button>' +
      '<div class="wb-grid">' + rows + "</div></div>";
  }

  /* ---------- 看板 ---------- */
  function renderDash() {
    var totalItems = 0, totalCorrect = 0;
    records.forEach(function (r) { r.items.forEach(function (it) { totalItems++; if (it.correct) totalCorrect++; }); });
    var acc = totalItems ? Math.round((totalCorrect / totalItems) * 100) : 0;
    var masteredCount = Object.keys(mastered).filter(function (k) { return mastered[k]; }).length;
    var due = dueWords();

    // 近 14 天正确率
    var days = dailyStats(14);
    var maxAcc = 100;
    var bars = days.map(function (d) {
      var h = d.total ? Math.max(4, Math.round(d.acc / maxAcc * 100)) : 2;
      return '<div class="bar-col"><div class="bar ' + (d.total ? "" : "zero") + '" style="height:' + h + '%" title="' + d.key + " 正确率" + d.acc + '%"></div>' +
        '<div class="bar-label">' + d.key.slice(5) + "</div></div>";
    }).join("");

    var wrong = aggregateWrong().slice(0, 10);
    var topHtml = wrong.length ? wrong.map(function (w, i) {
      return '<div class="list-row"><span><b>' + (i + 1) + ".</b> " + esc(w.word) + ' <span class="pinyin">' + py(w.pinyin) + "</span></span>" +
        '<span class="badge red">' + w.count + " 次</span></div>";
    }).join("") : '<p class="muted">暂无高频错词。</p>';

    var pie = pieChart(attrTotals());

    view.innerHTML =
      '<div class="stat-grid">' +
      stat(records.length, "练习次数") +
      stat(totalItems, "累计默写词数") +
      stat(acc + "%", "总正确率") +
      stat(masteredCount, "已掌握错词", masteredCount ? "show-mastered" : null) +
      stat(due.length, "今日待复习", due.length ? "show-due" : null) +
      "</div>" +
      '<div class="card"><div class="section-title">📈 近 14 天正确率</div><div class="bar-chart">' + bars + "</div></div>" +
      '<div class="card"><div class="section-title">🔝 高频错词 Top</div>' + topHtml + "</div>" +
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
  function closeModal() { modal.classList.add("hidden"); }

  /* ---------- 在线练习记录（历史） ---------- */
  function renderRecords() {
    if (!records.length) {
      view.innerHTML = '<div class="card empty">📭 还没有练习记录。<br/>去“去练习”做几次，或手动添加错词，这里就会留下历史。</div>';
      return;
    }
    var sorted = records.slice().sort(function (a, b) { return b.id - a.id; });
    var html = '<div class="card"><div class="section-title">📒 在线练习记录</div>' +
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

  function dailyStats(n) {
    var res = [], now = new Date();
    for (var i = n - 1; i >= 0; i--) {
      var d = new Date(now); d.setDate(now.getDate() - i);
      var key = d.toISOString().slice(0, 10), total = 0, correct = 0;
      records.forEach(function (r) {
        if (r.date === key) r.items.forEach(function (it) { total++; if (it.correct) correct++; });
      });
      res.push({ key: key, total: total, correct: correct, acc: total ? Math.round(correct / total * 100) : 0 });
    }
    return res;
  }

  function pieChart(totals) {
    var colors = { tone_same: "#4A90D9", shape_same: "#FF8A65", stroke: "#F4B400", pinyin: "#57B894", unknown: "#9B6DD6" };
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

    if (act === "exit") { practice = null; setTab("practice"); return; }
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
    if (act === "next") { if (practice.idx < practice.words.length - 1) { practice.idx++; renderQuiz(); } return; }
    if (act === "prev") { if (practice.idx > 0) { practice.idx--; renderQuiz(); } return; }
    if (act === "toreview") { practice.phase = "review"; return renderReview(); }

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

  // 出题方式切换
  view.addEventListener("click", function (e) {
    var b = e.target.closest("#modeSeg button");
    if (!b) return;
    if (!practice) practice = blankPractice(b.dataset.mode);
    else practice.mode = b.dataset.mode;
    document.querySelectorAll("#modeSeg button").forEach(function (x) { x.classList.toggle("on", x === b); });
  });

  // 词语库搜索（只刷新列表，保留输入框焦点）
  view.addEventListener("input", function (e) {
    if (e.target && e.target.id === "bankSearch") {
      window.__bankQ = e.target.value;
      var cu = computeUnits();
      var list = $("#bankList");
      if (list) list.innerHTML = bankListHtml(cu.units, cu.keys, window.__bankQ);
    }
  });

  // 拍照 / 上传图片：压缩后暂存
  view.addEventListener("change", function (e) {
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
    practice = { mode: (practice && practice.mode) || "tingxie", scope: scope, words: words, idx: 0, phase: "quiz", revealed: {}, results: [] };
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
    toast("已保存，去「在线练习记录」看看吧！📒");
    setTab("records");
  }

  function doAddWord() {
    var word = $("#nw").value.trim();
    var pinyin = $("#np").value.trim();
    if (!word || !pinyin) { toast("词语和拼音都要填"); return; }
    var unit = parseInt($("#nu").value, 10) || 1;
    var lesson = $("#nl").value.trim();
    customWords.push({ word: word, pinyin: pinyin, unit: unit, lesson: lesson });
    save(LS.custom, customWords);
    toast("已添加：" + word);
    renderBank();
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
    var pinyin = ($("#mp") ? $("#mp").value.trim() : "");
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

  /* ---------- 启动 ---------- */
  var SW_VER = "v6";
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("sw.js?v=" + SW_VER).catch(function () {});
    });
    var swReloaded = false;
    navigator.serviceWorker.addEventListener("controllerchange", function () {
      if (swReloaded) return;
      swReloaded = true;
      location.reload();
    });
  }
  setTab("dash");
})();
