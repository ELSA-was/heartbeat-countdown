/* VN Forge 2.0 player — no framework, no network calls at play time.
 * Story data comes from either an inlined `window.STORY` (built bundle)
 * or a sibling `story.json` (development mode). Nothing is generated at runtime. */
(function () {
  "use strict";

  var CORE = window.VNForge;
  var $ = function (id) { return document.getElementById(id); };

  var story = null, basePath = "", stamp = "";
  var steps = [], cursor = 0, trail = [];
  var segIndex = 0, typed = 0, typeTimer = null, autoTimer = null, autoOn = false;
  var currentEdges = [], awaitingChoice = false, lastBg = null, lastBgId = null;
  var audio = { bgm: null, bgmId: null, ctx: null };
  var meta = null, settings = null;
  var reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ------------------------------------------------------------- storage */
  function ls(k, def) {
    try { var v = localStorage.getItem(k); return v === null ? def : JSON.parse(v); }
    catch (e) { return def; }
  }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } }
  function metaKey() { return "vnf:" + story.meta.id + ":meta"; }
  function saveKey(n) { return "vnf:" + story.meta.id + ":save:" + n; }

  function defaultMeta() {
    return { cg: [], achievements: [], endings: [], chapters: [], settings: { speed: 28, autoDelay: 1400, bgm: 45, sfx: 70, scale: 1, skipUnread: false }, ageOk: false };
  }

  /* --------------------------------------------------------------- theme */
  function applyTheme() {
    var t = story.theme || {}, ui = t.ui || {}, f = t.frame || {}, m = t.motion || {};
    var map = {
      "--accent": ui.accent, "--accent-soft": ui.accentSoft, "--bg": ui.bg,
      "--panel": ui.panel, "--text": ui.text, "--muted": ui.muted
    };
    Object.keys(map).forEach(function (k) { if (map[k]) document.documentElement.style.setProperty(k, map[k]); });
    if (f.radius) document.documentElement.style.setProperty("--radius", f.radius + "px");
    if (f.dialogueOpacity) document.documentElement.style.setProperty("--dialogue-opacity", f.dialogueOpacity);
    if (f.portraitHeight) document.documentElement.style.setProperty("--portrait-height", f.portraitHeight);
    if (m.fadeMs) document.documentElement.style.setProperty("--fade", m.fadeMs + "ms");
    if (t.typography) {
      document.documentElement.style.setProperty("--font-body", quote(t.typography.body));
      document.documentElement.style.setProperty("--font-ui", quote(t.typography.ui));
    }
    document.documentElement.style.setProperty("--scale", String(settings.scale || 1));
    document.title = story.meta.title || "文字游戏";
  }
  function quote(s) { return /\s/.test(s || "") ? '"' + s + '"' : s; }

  /* --------------------------------------------------------------- utils */
  function asset(id) { return story.assets[id]; }
  function assetUrl(a) { return a && (a.data || a.path) ? (a.data ? a.data : basePath + a.path) : null; }

  /* 图片资源解析：path 可以写成不带扩展名的形式（assets/xu_neutral），
   * 引擎会依次探测 .jpg/.png/.webp —— 图还没生成就静默降级为文字卡，
   * 图一旦落盘，刷新页面即自动显示，不需要改任何代码。 */
  var EXTS = ["jpg", "jpeg", "png", "webp"];
  var urlCache = {};
  function hasExt(p) { return /\.(png|jpe?g|webp)$/i.test(p || ""); }
  function isImageish(a) { return !!a && a.type !== "bgm" && a.type !== "sfx"; }
  function resolveUrl(a, cb) {
    if (!a) { cb(null); return; }
    if (a.data) { cb(a.data); return; }
    var p = a.path;
    if (!p) { cb(null); return; }
    var base = basePath + p;
    if (!isImageish(a) || hasExt(p)) { cb(base); return; }
    if (urlCache[base] !== undefined) { cb(urlCache[base]); return; }
    var i = 0;
    (function attempt() {
      if (i >= EXTS.length) { urlCache[base] = null; cb(null); return; }
      var u = base + "." + EXTS[i++];
      var probe = new Image();
      probe.onload = function () { urlCache[base] = u; cb(u); };
      probe.onerror = function () { attempt(); };
      probe.src = u;
    })();
  }
  function resolveId(id, cb) { resolveUrl(asset(id), cb); }
  function toast(msg) {
    var el = $("toast"); el.textContent = msg; el.classList.add("on");
    clearTimeout(el._t); el._t = setTimeout(function () { el.classList.remove("on"); }, 1600);
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  function playSfx(id) {
    var a = asset(id); if (!a || !a.path || !settings.sfx) return;
    var s = new Audio(assetUrl(a)); s.volume = settings.sfx / 100;
    var p = s.play(); if (p && p.catch) p.catch(function () { });
  }

  function playBgm(id) {
    if (audio.bgmId === id) return;
    stopBgm();
    audio.bgmId = id;
    if (!id || !settings.bgm) return;
    var a = asset(id); if (!a || !a.path) return;
    var el = new Audio(assetUrl(a));
    el.loop = true; el.volume = settings.bgm / 100;
    var p = el.play(); if (p && p.catch) p.catch(function () { });
    audio.bgm = el;
  }
  function stopBgm() { if (audio.bgm) { try { audio.bgm.pause(); } catch (e) { } audio.bgm = null; } audio.bgmId = null; }
  function bgmVolume() { if (audio.bgm) audio.bgm.volume = settings.bgm / 100; if (!settings.bgm) stopBgm(); else if (audio.bgmId) { var i = audio.bgmId; audio.bgmId = null; playBgm(i); } }

  /* --------------------------------------------------------------- stage */
  function setBackground(id) {
    lastBgId = id;
    var img = $("bgImg");
    var a = id ? asset(id) : null;
    if (!a) { img.classList.remove("on"); img.removeAttribute("src"); lastBg = null; return; }
    resolveUrl(a, function (url) {
      if (!url) { img.classList.remove("on"); lastBg = null; return; }
      if (lastBg === url) { img.classList.add("on"); return; }
      lastBg = url;
      var next = new Image();
      next.onload = function () { img.src = url; img.classList.add("on"); };
      next.onerror = function () { img.classList.remove("on"); };
      next.src = url;
    });
  }

  function clearPortraits() { $("portraitLayer").innerHTML = ""; }

  function showCast(cast) {
    var layer = $("portraitLayer");
    layer.innerHTML = "";
    (cast || []).forEach(function (c) {
      var ch = story.characters[c.who]; if (!ch) return;
      var map = ch.portraits || {};
      var aid = map[c.emotion] || map.default;
      var wrap = document.createElement("div");
      wrap.className = "portrait " + (c.at || "center");
      wrap.dataset.who = c.who;
      if (c.scale) wrap.style.height = "calc(var(--portrait-height) * " + c.scale + " * 1%)";
      layer.appendChild(wrap);
      // 异步探测：图还没生成就静默不显示；生成完刷新或重新进节点即出现
      resolveId(aid, function (url) {
        if (!url || !wrap.isConnected) return;
        var img = document.createElement("img");
        img.alt = ch.name;
        img.onerror = function () { wrap.remove(); };
        img.onload = function () { wrap.classList.add("on"); };
        img.src = url;
        wrap.appendChild(img);
      });
    });
  }

  function setPortraitEmotion(who, emotion) {
    var ch = story.characters[who]; if (!ch) return;
    var aid = (ch.portraits || {})[emotion] || (ch.portraits || {}).default;
    var url = assetUrl(asset(aid)); if (!url) return;
    var node = $("portraitLayer").querySelector('[data-who="' + who + '"] img');
    if (!node) return;
    var next = new Image();
    next.onload = function () { node.src = url; };
    next.src = url;
  }

  function ambient(intimacy) {
    var el = $("ambLayer");
    if (intimacy && intimacy.tier === "adult") el.classList.add("on");
    else el.classList.remove("on");
  }

  function sceneCard(text) {
    if (!text) return;
    var el = $("sceneCard"); el.textContent = text; el.classList.add("on");
    clearTimeout(el._t); el._t = setTimeout(function () { el.classList.remove("on"); }, 1600);
  }

  function chapterCard(chapter) {
    if (!chapter) return Promise.resolve();
    if (meta.chapters.indexOf(chapter) >= 0) return Promise.resolve();
    meta.chapters.push(chapter); saveMeta();
    return new Promise(function (done) {
      var el = $("chapterCard");
      var parts = chapter.split(/[·:：]/);
      $("chNum").textContent = parts.length > 1 ? parts[0].trim() : "";
      $("chTitle").textContent = parts.length > 1 ? parts.slice(1).join("·").trim() : chapter;
      el.classList.add("on");
      var finish = function () { el.classList.remove("on"); el.removeEventListener("click", finish); clearTimeout(tid); done(); };
      el.addEventListener("click", finish);
      var tid = setTimeout(finish, reduceMotion ? 400 : 2100);
    });
  }

  /* -------------------------------------------------------------- unlocks */
  function unlockNode(node) {
    var dirty = false;
    (node.unlocks || []).forEach(function (id) { if (meta.cg.indexOf(id) < 0) { meta.cg.push(id); dirty = true; } });
    (node.awards || []).forEach(function (id) { if (meta.achievements.indexOf(id) < 0) { meta.achievements.push(id); dirty = true; } });
    if (node.ending) {
      if (meta.endings.indexOf(node.ending.id) < 0) { meta.endings.push(node.ending.id); dirty = true; }
      (node.ending.unlockCg || []).forEach(function (id) { if (meta.cg.indexOf(id) < 0) { meta.cg.push(id); dirty = true; } });
    }
    if (dirty) saveMeta();
  }

  /* ---------------------------------------------------------------- text */
  function stopTyping() { if (typeTimer) { clearInterval(typeTimer); typeTimer = null; } }

  function typeText(full, onDone) {
    var el = $("textMain");
    stopTyping();
    typed = 0; el.textContent = ""; $("nextHint").classList.remove("on");
    if (reduceMotion || settings.speed >= 200) { el.textContent = full; $("nextHint").classList.add("on"); if (onDone) onDone(); return; }
    var perTick = Math.max(1, Math.round(settings.speed / 20));
    typeTimer = setInterval(function () {
      typed = Math.min(full.length, typed + perTick);
      el.textContent = full.slice(0, typed);
      if (typed >= full.length) { stopTyping(); $("nextHint").classList.add("on"); if (onDone) onDone(); }
    }, 50);
  }

  function applySegment(seg) {
    var isLine = !!seg.speaker;
    var ch = isLine ? story.characters[seg.speaker] : null;
    var box = $("nameBox");
    if (ch) {
      box.classList.add("on");
      $("nameText").textContent = ch.name;
      box.dataset.who = seg.speaker;
      var hue = ch.color;
      box.style.removeProperty("--accent");
      if (hue) document.documentElement.style.setProperty("--accent", hue);
    } else {
      box.classList.remove("on");
      box.dataset.who = "";
      var base = (story.theme && story.theme.ui && story.theme.ui.accent) || "#C4577A";
      document.documentElement.style.setProperty("--accent", base);
    }
    if (seg.emotion && seg.speaker) setPortraitEmotion(seg.speaker, seg.emotion);
    if (seg.sfx) playSfx(seg.sfx);
    $("textMain").classList.toggle("intimate", !!(nodeIntimacy && nodeIntimacy.tier === "adult"));
  }

  var typeTimer2 = null;
  function playSegment(seg) {
    stopTyping();
    applySegment(seg);
    typeText(seg.text);
  }

  function finishSegment() {
    var seg = visible[segIndex];
    if (!seg) return;
    if (typeTimer) { stopTyping(); $("textMain").textContent = seg.text; $("nextHint").classList.add("on"); }
  }

  /* --------------------------------------------------------------- nodes */
  var visible = [], nodeIntimacy = null;

  function currentState() { return trail[cursor]; }

  function renderNode(opts) {
    opts = opts || {};
    var st = currentState(), node = story.nodes[st.node];
    visible = CORE.visibleSegments(story, st);
    nodeIntimacy = node.intimacy || null;
    segIndex = 0; awaitingChoice = false;

    ambient(nodeIntimacy);
    setBackground(node.background);
    showCast(node.cast);
    if (node.sfx) playSfx(node.sfx);
    if (node.bgm !== undefined) playBgm(node.bgm);
    sceneCard(opts.silent ? null : node.location);
    unlockNode(node);

    $("choices").classList.remove("on");
    $("choices").innerHTML = "";
    $("topLocation").textContent = node.location || "";
    $("topTitle").textContent = story.meta.title || "";

    return chapterCard(opts.silent ? null : node.chapter).then(function () { nextSegment(); });
  }

  function nextSegment() {
    if (segIndex >= visible.length) { showExits(); return; }
    playSegment(visible[segIndex]);
  }

  function advance() {
    if (awaitingChoice) return;
    var seg = visible[segIndex];
    if (seg && typeTimer) { finishSegment(); return; }
    segIndex++;
    if (segIndex < visible.length) { nextSegment(); return; }
    showExits();
  }

  function showExits() {
    var st = currentState(), node = story.nodes[st.node];
    if (node.ending) { showEnding(node); return; }
    awaitingChoice = true;
    var edges = CORE.edges(story, st);
    currentEdges = edges;
    if (!node.choices) {
      // next / routes present as a single "继续" button
      renderChoices([{ text: "继续", locked: false, nodeoholde: false, edge: edges[0] }], node);
      return;
    }
    var list = node.choices.map(function (c) {
      var open = edges.some(function (e) { return e.key === c.id; });
      return {
        text: c.text, hint: c.hint, lockedReason: open ? null : (c.lockedReason || "（现在还不能选）"),
        edge: open ? edges.filter(function (e) { return e.key === c.id; })[0] : null
      };
    });
    renderChoices(list, node);
  }

  function renderChoices(list, node) {
    var box = $("choices");
    box.innerHTML = "";
    list.forEach(function (item) {
      if (!item.text && !item.lockedReason) return;
      var b = document.createElement("button");
      b.className = "choice" + (item.edge ? "" : " locked");
      var html = esc(item.text || "继续");
      if (item.hint) html += '<span class="hint">' + esc(item.hint) + "</span>";
      if (!item.edge && item.lockedReason) html += '<span class="lock">' + esc(item.lockedReason) + "</span>";
      b.innerHTML = html;
      if (item.edge) b.addEventListener("click", function () { pick(item.edge); });
      else b.disabled = true;
      box.appendChild(b);
    });
    box.classList.add("on");
    $("nextHint").classList.remove("on");
  }

  function pick(edge) {
    stopAuto();
    steps = steps.slice(0, cursor);
    steps.push(edge.key);
    rebuildTrail(steps.length);
    renderNode();
  }

  function rebuildTrail(target) {
    trail = CORE.replay(story, steps.slice(0, target));
    cursor = trail.length - 1;
  }

  function showEnding(node) {
    stopAuto();
    awaitingChoice = true;
    $("choices").classList.remove("on");
    var e = node.ending;
    openOverlay('<div class="ov-head"><h2>抵达结局</h2><span class="spacer"></span><button class="ov-close" data-close>✕</button></div>' +
      '<div class="end-item"><b>' + esc(e.kind) + "　" + esc(e.name) + "</b><small>" + esc(e.summary || "") + "</small></div>" +
      '<div class="menu-grid" style="margin-top:16px">' +
      '<button class="mbtn" id="endGallery">查看 CG 画廊</button>' +
      '<button class="mbtn" id="endTitle">回到标题</button></div>');
    $("endGallery").onclick = function () { openGallery(); };
    $("endTitle").onclick = function () { backToTitle(); };
  }

  /* ------------------------------------------------------------- overlays */
  function openOverlay(html) {
    $("ovPanel").innerHTML = html;
    $("overlay").hidden = false;
    Array.prototype.forEach.call($("ovPanel").querySelectorAll("[data-close]"), function (b) {
      b.onclick = closeOverlay;
    });
  }
  function closeOverlay() { $("overlay").hidden = true; $("ovPanel").innerHTML = ""; }
  function overlayOpen() { return !$("overlay").hidden; }

  function openMenu() {
    openOverlay('<div class="ov-head"><h2>菜单</h2><span class="spacer"></span><button class="ov-close" data-close>✕</button></div>' +
      '<div class="menu-grid">' +
      "<button class=\"mbtn\" data-close>继续</button>" +
      '<button class="mbtn" id="mSave">保存</button>' +
      '<button class="mbtn" id="mLoad">读取</button>' +
      '<button class="mbtn" id="mHist">历史</button>' +
      '<button class="mbtn" id="mGal">CG 画廊</button>' +
      '<button class="mbtn" id="mEnd">结局图鉴</button>' +
      '<button class="mbtn" id="mAch">成就</button>' +
      '<button class="mbtn" id="mSet">设置</button>' +
      '<button class="mbtn" id="mTitle">回到标题</button>' +
      "</div>");
    $("mSave").onclick = openSave; $("mLoad").onclick = openLoad; $("mHist").onclick = openHistory;
    $("mGal").onclick = openGallery; $("mEnd").onclick = openEndings; $("mAch").onclick = openAchievements;
    $("mSet").onclick = openSettings;
    $("mTitle").onclick = function () { closeOverlay(); backToTitle(); };
  }

  var slotRender = function (mode) {
    var html = '<div class="ov-head"><h2>' + (mode === "save" ? "保存进度" : "读取进度") + '</h2><span class="spacer"></span><button class="ov-close" data-close>✕</button></div>';
    for (var i = 1; i <= 6; i++) {
      var s = ls(saveKey(i), null);
      var bad = s && s.stamp !== stamp;
      html += '<div class="slot" data-slot="' + i + '">' +
        '<span class="no">' + i + "</span>" +
        '<span class="meta"><b>' + (s ? esc(s.title) : "（空）") + "</b><small>" +
        (s ? (bad ? "存档来自旧版本，无法读取" : new Date(s.ts).toLocaleString()) + "　" + esc(s.node) : "尚未使用") +
        "</small></span>" +
        (s ? '<button class="del" data-del="' + i + '">删除</button>' : "") +
        "</div>";
    }
    html += '<div class="setting-row"><label>存档码</label><textarea id="slotCode" rows="3" style="flex:1;background:rgba(255,255,255,.06);color:var(--text);border:1px solid rgba(255,255,255,.16);border-radius:8px;padding:8px" placeholder="粘贴存档码后点“导入”，或点“导出”复制当前进度"></textarea></div>' +
      '<div class="menu-grid"><button class="mbtn" id="slotExport">导出当前进度</button><button class="mbtn" id="slotImport">导入存档码</button></div>';
    openOverlay(html);
    Array.prototype.forEach.call($("ovPanel").querySelectorAll(".slot"), function (el) {
      var n = +el.dataset.slot;
      el.onclick = function (ev) {
        if (ev.target.dataset.del) { localStorage.removeItem(saveKey(n)); slotRender(mode); return; }
        var s = ls(saveKey(n), null);
        if (!s) return;
        if (s.stamp !== stamp) { toast("存档版本不一致"); return; }
        if (mode === "save") {
          var st = currentState();
          lsSet(saveKey(n), { steps: steps.slice(0, cursor), title: story.nodes[st.node].title, node: story.nodes[st.node].location || "", ts: Date.now(), stamp: stamp });
          toast("已保存到槽位 " + n); closeOverlay();
        } else {
          steps = s.steps.slice(); rebuildTrail(steps.length); closeOverlay(); renderNode();
        }
      };
    });
    $("slotExport").onclick = function () {
      $("slotCode").value = btoa(unescape(encodeURIComponent(JSON.stringify({ story: story.meta.id, stamp: stamp, steps: steps.slice(0, cursor) }))));
      $("slotCode").select();
    };
    $("slotImport").onclick = function () {
      try {
        var obj = JSON.parse(decodeURIComponent(escape(atob($("slotCode").value.trim()))));
        if (obj.stamp !== stamp) { toast("存档码版本不一致"); return; }
        steps = obj.steps.slice(); rebuildTrail(steps.length); closeOverlay(); renderNode();
      } catch (e) { toast("存档码格式错误"); }
    };
  };
  var openSave = function () { slotRender("save"); };
  var openLoad = function () { slotRender("load"); };

  function openHistory() {
    var html = '<div class="ov-head"><h2>历史</h2><span class="spacer"></span><button class="ov-close" data-close>✕</button></div>';
    var rows = 0;
    for (var i = 0; i <= cursor; i++) {
      var st = trail[i], node = story.nodes[st.node];
      CORE.visibleSegments(story, st).forEach(function (s) {
        rows++;
        var ch = s.speaker ? story.characters[s.speaker] : null;
        html += '<div class="hist-item" data-i="' + i + '">' +
          (ch ? '<span class="who">' + esc(ch.name) + "</span>" : "") + esc(s.text) + "</div>";
      });
    }
    if (!rows) html += '<p style="color:var(--muted)">还没有可读的历史。</p>';
    openOverlay(html);
    Array.prototype.forEach.call($("ovPanel").querySelectorAll(".hist-item"), function (el) {
      el.onclick = function () { cursor = +el.dataset.i; closeOverlay(); renderNode({ silent: true }); };
    });
  }

  function galleryList() {
    return Object.keys(story.assets).filter(function (k) { return story.assets[k].type === "cg" && story.assets[k].gallery; })
      .sort(function (a, b) { return (story.assets[a].galleryOrder || 0) - (story.assets[b].galleryOrder || 0); });
  }

  function openGallery() {
    var list = galleryList();
    if (!list.length) { openOverlay('<div class="ov-head"><h2>CG 画廊</h2><span class="spacer"></span><button class="ov-close" data-close>✕</button></div><p style="color:var(--muted)">本作还没有登记 CG。</p>'); return; }
    var got = list.filter(function (id) { return meta.cg.indexOf(id) >= 0; }).length;
    var html = '<div class="ov-head"><h2>CG 画廊　<small style="color:var(--muted)">' + got + " / " + list.length + '</small></h2><span class="spacer"></span><button class="ov-close" data-close>✕</button></div><div class="gal-grid">';
    list.forEach(function (id) {
      var a = story.assets[id], open = meta.cg.indexOf(id) >= 0;
      var url = assetUrl(a);
      html += '<div class="gal-cell' + (open ? "" : " locked") + '">' +
        (url && open ? '<img src="' + esc(url) + '" alt="">' : '<span class="lockicon">🔒</span>') +
        '<span class="cap">' + esc(open ? (a.galleryTitle || a.label || id) : "???") + "</span></div>";
    });
    openOverlay(html + "</div>");
  }

  function openEndings() {
    var groups = {};
    Object.keys(story.nodes).forEach(function (k) {
      var n = story.nodes[k]; if (!n.ending) return;
      var kind = n.ending.kind || "ENDING";
      (groups[kind] = groups[kind] || []).push(n.ending);
    });
    var html = '<div class="ov-head"><h2>结局图鉴　<small style="color:var(--muted)">' + meta.endings.length + " / " + Object.keys(groups).reduce(function (a, k) { return a + groups[k].length; }, 0) + '</small></h2><span class="spacer"></span><button class="ov-close" data-close>✕</button></div>';
    Object.keys(groups).forEach(function (kind) {
      html += '<div class="end-group"><h3>' + esc(kind) + "</h3>";
      groups[kind].forEach(function (e) {
        var got = meta.endings.indexOf(e.id) >= 0;
        html += '<div class="end-item"><b>' + esc(got ? e.name : "???") + "</b><small>" + esc(got ? (e.summary || "") : "尚未抵达") + "</small></div>";
      });
      html += "</div>";
    });
    openOverlay(html);
  }

  function openAchievements() {
    var ids = Object.keys(story.achievements || {});
    if (!ids.length) { openOverlay('<div class="ov-head"><h2>成就</h2><span class="spacer"></span><button class="ov-close" data-close>✕</button></div><p style="color:var(--muted)">本作没有设置成就。</p>'); return; }
    var got = ids.filter(function (id) { return meta.achievements.indexOf(id) >= 0; }).length;
    var html = '<div class="ov-head"><h2>成就　<small style="color:var(--muted)">' + got + " / " + ids.length + '</small></h2><span class="spacer"></span><button class="ov-close" data-close>✕</button></div>';
    ids.forEach(function (id) {
      var a = story.achievements[id], has = meta.achievements.indexOf(id) >= 0;
      html += '<div class="end-item"><b>' + esc(has || !a.hidden ? a.title : "???") + "</b><small>" + esc(has || !a.hidden ? (a.description || "") : "隐藏成就") + "</small></div>";
    });
    openOverlay(html);
  }

  function openSettings() {
    var rows = [
      ["speed", "文本速度", 10, 200, 10, function (v) { return v >= 200 ? "瞬时" : v + " 字/秒"; }],
      ["autoDelay", "自动间隔", 600, 4000, 100, function (v) { return (v / 1000).toFixed(1) + " 秒"; }],
      ["bgm", "音乐音量", 0, 100, 5, function (v) { return v + "%"; }],
      ["sfx", "音效音量", 0, 100, 5, function (v) { return v + "%"; }],
      ["scale", "字号倍率", 0.9, 1.4, 0.05, function (v) { return v.toFixed(2) + "×"; }]
    ];
    var html = '<div class="ov-head"><h2>设置</h2><span class="spacer"></span><button class="ov-close" data-close>✕</button></div>';
    rows.forEach(function (r) {
      html += '<div class="setting-row"><label>' + r[1] + '</label><input type="range" data-k="' + r[0] + '" min="' + r[2] + '" max="' + r[3] + '" step="' + r[4] + '" value="' + settings[r[0]] + '"><output data-o="' + r[0] + '">' + r[5](settings[r[0]]) + "</output></div>";
    });
    html += '<div class="setting-row"><label>跳过未读</label><input type="checkbox" id="setSkip"' + (settings.skipUnread ? " checked" : "") + '><output>遇到选项停下</output></div>';
    html += '<div class="menu-grid" style="margin-top:14px"><button class="mbtn" id="setReset">清除全部记录</button></div>';
    openOverlay(html);
    Array.prototype.forEach.call($("ovPanel").querySelectorAll("input[type=range]"), function (inp) {
      inp.oninput = function () {
        var k = inp.dataset.k; settings[k] = parseFloat(inp.value);
        $("ovPanel").querySelector('[data-o="' + k + '"]').textContent =
          rows.filter(function (r) { return r[0] === k; })[0][5](settings[k]);
        if (k === "scale") document.documentElement.style.setProperty("--scale", String(settings.scale));
        if (k === "bgm") bgmVolume();
        saveMeta();
      };
    });
    $("setSkip").onchange = function () { settings.skipUnread = $("setSkip").checked; saveMeta(); };
    $("setReset").onclick = function () {
      meta = defaultMeta(); settings = meta.settings; lsSet(metaKey(), meta);
      closeOverlay(); toast("已清除"); backToTitle();
    };
  }

  /* ---------------------------------------------------------- navigation */
  function back() {
    if (awaitingChoice || cursor <= 0) return;
    stopAuto();
    cursor--;
    renderNode({ silent: true });
  }

  function stopAuto() {
    autoOn = false;
    if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
    $("btnAuto").classList.remove("on");
  }
  function toggleAuto() {
    autoOn = !autoOn;
    $("btnAuto").classList.toggle("on", autoOn);
    if (autoOn) startAuto(); else stopAuto();
  }
  function startAuto() {
    if (autoTimer) clearInterval(autoTimer);
    autoTimer = setInterval(function () {
      if (overlayOpen() || $("chapterCard").classList.contains("on")) return;
      if (awaitingChoice) { stopAuto(); return; }
      advance();
    }, settings.autoDelay);
  }

  function skipUnread() {
    var guard = 0;
    while (guard++ < 400) {
      if (awaitingChoice) return;
      finishSegment();
      var st = currentState(), node = story.nodes[st.node];
      if (node.ending) { showExits(); return; }
      segIndex++;
      if (segIndex >= visible.length) {
        if (node.choices) { showExits(); return; }
        awaitingChoice = false;
        pick(CORE.edges(story, st)[0]);
        continue;
      }
      applySegment(visible[segIndex]);
      typeText(visible[segIndex].text);
      finishSegment();
    }
    toast("跳过已停止");
  }

  function backToTitle() {
    stopAuto(); stopBgm(); clearPortraits(); setBackground(null);
    $("overlay").hidden = true;
    $("choices").classList.remove("on");
    showTitle();
  }

  /* --------------------------------------------------------------- title */
  function showTitle() {
    var cover = null;
    Object.keys(story.assets).forEach(function (k) { if (story.assets[k].type === "cover" && !cover) cover = story.assets[k]; });
    var adult = story.meta.contentTier === "adult";
    if (adult && !meta.ageOk) { showAgeGate(); return; }
    if (cover) resolveUrl(cover, function (url) { if (url) setBackgroundSrc(url); });
    $("topTitle").textContent = ""; $("topLocation").textContent = "";
    $("textMain").textContent = ""; $("nameBox").classList.remove("on");
    var html = '<div class="ov-head"><h2>' + esc(story.meta.title || "") + "</h2></div>" +
      (story.meta.subtitle ? '<p style="color:var(--muted);margin:0 0 14px">' + esc(story.meta.subtitle) + "</p>" : "") +
      '<div class="menu-grid">' +
      '<button class="mbtn" id="tStart">' + (meta.endings.length ? "重新开始" : "开始游戏") + "</button>" +
      '<button class="mbtn" id="tContinue">继续</button>' +
      '<button class="mbtn" id="tLoad">读取进度</button>' +
      '<button class="mbtn" id="tGal">CG 画廊</button>' +
      '<button class="mbtn" id="tEnd">结局图鉴</button>' +
      '<button class="mbtn" id="tAch">成就</button>' +
      '<button class="mbtn" id="tSet">设置</button>' +
      "</div>" +
      (story.meta.description ? '<p style="color:var(--muted);font-size:.86em;line-height:1.7;margin:16px 0 0">' + esc(story.meta.description) + "</p>" : "") +
      (story.meta.author ? '<p style="color:var(--muted);font-size:.8em;margin:8px 0 0">作者：' + esc(story.meta.author) + "</p>" : "");
    openOverlay(html);
    $("ovPanel").style.background = "rgba(20,16,26,.55)";
    $("tStart").onclick = function () { steps = []; rebuildTrail(0); closeOverlay(); $("ovPanel").style.background = ""; renderNode(); };
    $("tContinue").onclick = function () { closeOverlay(); $("ovPanel").style.background = ""; renderNode({ silent: true }); };
    $("tLoad").onclick = function () { $("ovPanel").style.background = ""; openLoad(); };
    $("tGal").onclick = function () { $("ovPanel").style.background = ""; openGallery(); };
    $("tEnd").onclick = function () { $("ovPanel").style.background = ""; openEndings(); };
    $("tAch").onclick = function () { $("ovPanel").style.background = ""; openAchievements(); };
    $("tSet").onclick = function () { $("ovPanel").style.background = ""; openSettings(); };
  }

  function setBackgroundSrc(url) {
    var img = $("bgImg");
    if (!url) { img.classList.remove("on"); return; }
    lastBg = url;
    var n = new Image();
    n.onload = function () { img.src = url; img.classList.add("on"); };
    n.onerror = function () { img.classList.remove("on"); };
    n.src = url;
  }

  function showAgeGate() {
    $("agegate").hidden = false;
    $("ageTitle").textContent = story.meta.title || "";
    $("ageNote").textContent = story.meta.contentNote || "";
  }

  /* ----------------------------------------------------------------- boot */
  function saveMeta() { meta.settings = settings; lsSet(metaKey(), meta); }

  function wireInput() {
    var app = $("app");
    app.addEventListener("click", function (ev) {
      if (overlayOpen() || !$("agegate").hidden) return;
      if (ev.target.closest(".choice") || ev.target.closest("#topBtns")) return;
      if ($("chapterCard").classList.contains("on")) return;
      advance();
    });
    document.addEventListener("keydown", function (e) {
      if (!$("agegate").hidden) return;
      if (e.key === "Escape") { overlayOpen() ? closeOverlay() : openMenu(); return; }
      if (overlayOpen()) return;
      if (e.key === " " || e.key === "Enter") { e.preventDefault(); advance(); }
      if (e.key === "ArrowLeft") back();
      if (e.key === "ArrowUp") openHistory();
      if (e.key === "a" || e.key === "A") toggleAuto();
      if (e.key === "s" || e.key === "S") { if (e.ctrlKey) { e.preventDefault(); openSave(); } }
    });
    $("btnMenu").onclick = openMenu;
    $("btnHistory").onclick = openHistory;
    $("btnAuto").onclick = toggleAuto;
    $("btnSkip").onclick = skipUnread;
    $("ageYes").onclick = function () { meta.ageOk = true; saveMeta(); $("agegate").hidden = true; showTitle(); };
    $("ageNo").onclick = function () { document.body.innerHTML = '<div style="display:grid;place-items:center;height:100%;color:#9A8FA6;font-family:sans-serif">感谢访问，再见。</div>'; };
    // unlock audio on first gesture (browser autoplay policy)
    var once = function () { playBgm(audio.bgmId); document.removeEventListener("pointerdown", once); };
    document.addEventListener("pointerdown", once);
  }

  function boot(data, base) {
    story = data; basePath = base || "";
    stamp = CORE.stamp(story);
    meta = Object.assign(defaultMeta(), ls(metaKey(), {}));
    settings = meta.settings || defaultMeta().settings;
    applyTheme();
    rebuildTrail(0);
    wireInput();
    showTitle();
  }

  function start() {
    if (window.STORY) { boot(window.STORY, window.STORY_BASE || ""); return; }
    var base = location.search.indexOf("dev=1") >= 0 ? "" : "";
    fetch(base + "story.json", { cache: "no-store" })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (j) { boot(j, base); })
      .catch(function (e) {
        document.body.innerHTML = '<pre style="padding:24px;color:#c4577a;font-family:sans-serif">' +
          "无法载入剧情数据： " + esc(e.message) + "\n\n" +
          "开发模式：把 player.html / theme.css / core.js / app.js 与 story.json 放在同一目录，用本地服务器打开（不要直接双击 file://）。\n" +
          "发布模式：先运行 build.js 生成单文件 dist/game.html。</pre>";
      });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
