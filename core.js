/* VN Forge 2.0 — shared, dependency-free deterministic story core.
 *
 * Browser:  <script src="core.js"></script>  -> window.VNForge
 * Node:     require('./core.js')             -> module.exports
 *
 * Guarantees:
 *   - same story + same step sequence => same state, forever
 *   - no eval, no expression strings, no Date, no Math.random
 *   - unknown fields are ERRORS, never silently ignored
 *   - every intimate character is declared >= 18 years old
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.VNForge = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const object = x => x !== null && typeof x === "object" && !Array.isArray(x);
  const clone = x => JSON.parse(JSON.stringify(x));
  const ident = s => typeof s === "string" && /^[A-Za-z][A-Za-z0-9_]*$/.test(s) &&
    !["constructor", "prototype", "__proto__"].includes(s);

  const TIERS = ["all", "romance", "adult"];
  const STAGES = ["approach", "foreplay", "act", "climax", "aftercare"];
  const ASSET_TYPES = ["background", "portrait", "cg", "bgm", "sfx", "cover"];
  const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;
  const AUDIO_EXT = /\.(mp3|ogg|wav)$/i;

  const ALLOW = {
    root: ["schemaVersion", "meta", "theme", "start", "variables", "characters", "achievements", "assets", "nodes"],
    meta: ["id", "version", "title", "subtitle", "author", "description", "contentTier", "contentNote"],
    varDecl: ["type", "initial", "min", "max", "values", "label", "visible", "group"],
    char: ["name", "age", "role", "personality", "voiceCue", "arc", "description", "visual", "portraits", "color"],
    visual: ["face", "hair", "body", "outfit", "colors", "seed", "negative"],
    ach: ["title", "description", "hidden"],
    asset: ["type", "label", "path", "prompt", "character", "emotion", "anchorFrom",
      "gallery", "galleryTitle", "galleryOrder", "tier", "ratio", "tags", "bpm", "loop"],
    node: ["chapter", "title", "location", "background", "bgm", "cast", "transition", "sfx",
      "notes", "segments", "choices", "next", "routes", "ending", "unlocks", "awards", "intimacy"],
    seg: ["text", "speaker", "emotion", "when", "sfx"],
    cast: ["who", "emotion", "at", "scale"],
    choice: ["id", "text", "next", "when", "lockedReason", "effects", "feedback", "hint"],
    ending: ["id", "name", "kind", "tier", "summary", "unlockCg"],
    intimacy: ["tier", "stage", "partners", "consent"]
  };

  /* ---------------------------------------------------------------- runtime */

  function valueOK(d, v) {
    if (d.type === "int") return Number.isSafeInteger(v) && v >= d.min && v <= d.max;
    if (d.type === "bool") return typeof v === "boolean";
    return d.type === "enum" && typeof v === "string" && d.values.includes(v);
  }

  function condition(c, vars) {
    if (c === undefined || c === true) return true;
    if (c === false) return false;
    if (own(c, "all")) return c.all.every(x => condition(x, vars));
    if (own(c, "any")) return c.any.some(x => condition(x, vars));
    if (own(c, "not")) return !condition(c.not, vars);
    const a = vars[c.var], b = c.value;
    switch (c.op) {
      case "==": return a === b;
      case "!=": return a !== b;
      case ">": return a > b;
      case ">=": return a >= b;
      case "<": return a < b;
      case "<=": return a <= b;
      default: throw new Error("未知条件操作符: " + c.op);
    }
  }

  function initial(story) {
    const vars = {};
    for (const [k, d] of Object.entries(story.variables)) vars[k] = d.initial;
    return { node: story.start, vars, feedback: "" };
  }

  function apply(story, vars, effects) {
    const out = { ...vars };
    for (const e of effects || []) {
      if (own(e, "set")) out[e.set] = e.value;
      else {
        const d = story.variables[e.add];
        out[e.add] = Math.min(d.max, Math.max(d.min, out[e.add] + e.value));
      }
    }
    return out;
  }

  function edges(story, state) {
    const n = story.nodes[state.node];
    if (n.ending) return [];
    if (n.choices) return n.choices
      .filter(c => condition(c.when, state.vars))
      .map(c => ({ key: c.id, text: c.text, next: c.next, effects: c.effects || [], feedback: c.feedback || "" }));
    if (n.next) return [{ key: "#next", text: "继续", next: n.next, effects: [], feedback: "" }];
    const i = n.routes.findIndex(r => condition(r.when, state.vars));
    return i < 0 ? [] : [{ key: "#route_" + i, text: "继续", next: n.routes[i].next, effects: [], feedback: "" }];
  }

  function step(story, state, key) {
    const e = edges(story, state).find(x => x.key === key);
    if (!e) throw new Error("该选择在当前状态不可用: " + key);
    return { node: e.next, vars: apply(story, state.vars, e.effects), feedback: e.feedback };
  }

  function visibleSegments(story, state) {
    return story.nodes[state.node].segments.filter(s => condition(s.when, state.vars));
  }

  function replay(story, steps) {
    if (!Array.isArray(steps) || steps.length > 10000 || steps.some(x => typeof x !== "string"))
      throw new Error("存档步骤格式错误或超过 10000 步");
    const trail = [initial(story)];
    for (const key of steps) trail.push(step(story, trail[trail.length - 1], key));
    return trail;
  }

  /** Collect idempotent unlocks (CG + achievements) along a played trail. */
  function collect(story, trail) {
    const cg = new Set(), ach = new Set(), endings = new Set();
    for (const s of trail) {
      const n = story.nodes[s.node];
      for (const id of n.unlocks || []) cg.add(id);
      for (const id of n.awards || []) ach.add(id);
      if (n.ending) {
        endings.add(n.ending.id);
        for (const id of n.ending.unlockCg || []) cg.add(id);
      }
    }
    return { cg: [...cg], achievements: [...ach], endings: [...endings] };
  }

  /** Short fingerprint used to reject saves from incompatible builds. */
  function stamp(story) {
    let h = 2166136261;
    const feed = JSON.stringify([story.meta.id, story.meta.version, Object.keys(story.nodes).sort()]);
    for (let i = 0; i < feed.length; i++) {
      h ^= feed.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h.toString(36) + "-" + Object.keys(story.nodes).length;
  }

  /* -------------------------------------------------------------- validate */

  function validate(story) {
    const errors = [], warnings = [];
    const error = (p, m) => errors.push(p + ": " + m);
    const text = (x, p) => { if (typeof x !== "string" || !x.trim()) error(p, "必须为非空文本"); };
    const optText = (x, p) => { if (x !== undefined && typeof x !== "string") error(p, "必须是文本"); };
    const keys = (o, allowed, p) => {
      if (!object(o)) { error(p, "必须是对象"); return false; }
      for (const k of Object.keys(o)) if (!allowed.includes(k)) error(p + "." + k, "未知字段（防止静默忽略拼写错误）");
      return true;
    };

    if (!object(story)) return { errors: ["根节点必须是对象"], warnings };
    keys(story, ALLOW.root, "$root");
    if (story.schemaVersion !== 2) error("schemaVersion", "本引擎只支持 2");

    let tier = null;
    if (!object(story.meta)) error("meta", "必须是对象");
    else {
      keys(story.meta, ALLOW.meta, "meta");
      if (!ident(story.meta.id)) error("meta.id", "须为安全英文 ID");
      ["title", "version"].forEach(k => text(story.meta[k], "meta." + k));
      ["subtitle", "author", "description", "contentNote"].forEach(k => optText(story.meta[k], "meta." + k));
      if (!TIERS.includes(story.meta.contentTier)) error("meta.contentTier", "须为 all / romance / adult");
      else tier = story.meta.contentTier;
    }

    if (story.theme !== undefined && !object(story.theme)) error("theme", "必须是对象");
    for (const k of ["variables", "characters", "achievements", "assets", "nodes"])
      if (!object(story[k])) error(k, "必须是对象");
    if (errors.length) return { errors, warnings };

    if (!Object.keys(story.nodes).length) error("nodes", "不能为空");

    /* variables */
    for (const [k, d] of Object.entries(story.variables)) {
      const p = "variables." + k;
      if (!ident(k)) error(p, "不安全的 ID");
      if (!keys(d, ALLOW.varDecl, p)) continue;
      if (!["int", "bool", "enum"].includes(d.type)) { error(p, "未知类型"); continue; }
      if (own(d, "visible") && typeof d.visible !== "boolean") error(p, "visible 须为布尔值");
      ["label", "group"].forEach(t => optText(d[t], p + "." + t));
      if (d.type === "int" && (!Number.isSafeInteger(d.min) || !Number.isSafeInteger(d.max) ||
        d.min > d.max || Math.abs(d.min) > 1e6 || Math.abs(d.max) > 1e6)) { error(p, "int 范围须在 ±1000000 内且 min<=max"); continue; }
      if (d.type === "enum" && (!Array.isArray(d.values) || !d.values.length ||
        d.values.some(v => typeof v !== "string") || new Set(d.values).size !== d.values.length)) { error(p, "enum 需唯一字符串 values"); continue; }
      if (!valueOK(d, d.initial)) error(p, "initial 类型或范围错误");
    }

    /* characters */
    for (const [k, c] of Object.entries(story.characters)) {
      const p = "characters." + k;
      if (!ident(k)) error(p, "不安全的 ID");
      if (!keys(c, ALLOW.char, p)) continue;
      text(c.name, p + ".name");
      if (!Number.isInteger(c.age) || c.age < 18) error(p + ".age", "本工具包要求角色明确 ≥18 岁");
      ["role", "personality", "voiceCue", "arc", "description", "color"].forEach(t => optText(c[t], p + "." + t));
      if (own(c, "visual") && !keys(c.visual, ALLOW.visual, p + ".visual")) continue;
      if (!own(c, "portraits") || !object(c.portraits) || !own(c.portraits, "default"))
        error(p + ".portraits", "必须提供 default 情绪映射");
    }

    /* achievements */
    for (const [k, a] of Object.entries(story.achievements)) {
      const p = "achievements." + k;
      if (!ident(k)) error(p, "不安全的 ID");
      if (!keys(a, ALLOW.ach, p)) continue;
      text(a.title, p + ".title");
      optText(a.description, p + ".description");
      if (own(a, "hidden") && typeof a.hidden !== "boolean") error(p + ".hidden", "须为布尔值");
    }

    /* assets */
    for (const [k, a] of Object.entries(story.assets)) {
      const p = "assets." + k;
      if (!ident(k)) error(p, "不安全的 ID");
      if (!keys(a, ALLOW.asset, p)) continue;
      if (!ASSET_TYPES.includes(a.type)) { error(p, "未知资源类型"); continue; }
      ["prompt", "label", "ratio", "tier", "galleryTitle"].forEach(t => optText(a[t], p + "." + t));
      if (own(a, "gallery") && typeof a.gallery !== "boolean") error(p + ".gallery", "须为布尔值");
      if (own(a, "tags") && (!Array.isArray(a.tags) || a.tags.some(t => typeof t !== "string"))) error(p + ".tags", "须为字符串数组");
      if (own(a, "bpm") && !Number.isFinite(a.bpm)) error(p + ".bpm", "须为数字");
      if (own(a, "character") && !own(story.characters, a.character)) error(p + ".character", "角色不存在");
      if (a.path !== undefined) {
        const pattern = ["bgm", "sfx"].includes(a.type) ? AUDIO_EXT : IMAGE_EXT;
        if (typeof a.path !== "string" || !/^[A-Za-z0-9_\-/.]+$/.test(a.path) || a.path.startsWith("/") ||
          a.path.split("/").some(s => !s || s === ".." || s === ".") ||
          // 带扩展名时必须是受支持类型；无扩展名放行（引擎运行时自动探测 jpg/png/webp）
          (!pattern.test(a.path) && /\.[A-Za-z0-9]+$/.test(a.path)))
          error(p + ".path", "只允许 ASCII 相对资源路径及受支持扩展名");
      } else warnings.push(p + ": 待制作资源，运行时降级为文字卡或静音");
    }

    if (errors.length) return { errors, warnings };

    /* helpers valid only after declarations check out */
    function checkCondition(c, p, depth) {
      depth = depth || 0;
      if (c === undefined || typeof c === "boolean") return;
      if (!object(c) || depth > 20) return error(p, "条件必须是对象/布尔，嵌套 ≤20");
      if (own(c, "all") || own(c, "any")) {
        const k = own(c, "all") ? "all" : "any";
        keys(c, [k], p);
        if (!Array.isArray(c[k]) || !c[k].length) return error(p, "逻辑组合不可为空");
        c[k].forEach((x, i) => checkCondition(x, p + "." + k + "[" + i + "]", depth + 1));
      } else if (own(c, "not")) {
        keys(c, ["not"], p);
        checkCondition(c.not, p + ".not", depth + 1);
      } else {
        keys(c, ["var", "op", "value"], p);
        if (!own(story.variables, c.var)) return error(p, "引用未声明变量: " + c.var);
        const d = story.variables[c.var];
        if (!["==", "!=", ">", ">=", "<", "<="].includes(c.op)) error(p, "未知比较操作符");
        if ([">", ">=", "<", "<="].includes(c.op) && d.type !== "int") error(p, "大小比较只能用于 int");
        if (!valueOK(d, c.value)) error(p, "比较值类型错误或超出变量域");
      }
    }

    function effects(es, p) {
      if (es === undefined) return;
      if (!Array.isArray(es)) return error(p, "effects 须为数组");
      es.forEach((e, i) => {
        const ep = p + "[" + i + "]";
        if (!object(e)) return error(ep, "效果须为对象");
        const k = own(e, "set") ? "set" : "add";
        keys(e, [k, "value"], ep);
        if (!own(story.variables, e[k])) return error(ep, "引用未声明变量");
        const d = story.variables[e[k]];
        if (k === "set" && !valueOK(d, e.value)) error(ep, "赋值类型或范围错误");
        if (k === "add" && (d.type !== "int" || !Number.isSafeInteger(e.value) || Math.abs(e.value) > 1e6))
          error(ep, "add 仅接受 int 与有界整数增量");
      });
    }

    const ref = (id, p) => { if (typeof id !== "string" || !own(story.nodes, id)) error(p, "目标节点不存在: " + id); };
    const assetRef = (id, types, p) => {
      if (id === undefined || id === null) return;
      if (!own(story.assets, id) || !types.includes(story.assets[id].type))
        error(p, "资源不存在或类型不匹配: " + id);
    };
    const cgRef = (id, p) => {
      if (!own(story.assets, id)) return error(p, "CG 不存在: " + id);
      if (story.assets[id].type !== "cg") error(p, "该资源不是 cg 类型: " + id);
    };

    ref(story.start, "start");

    const endings = new Set(), usedAch = new Set(), usedCg = new Set(), galleryDeclared = [];
    for (const [k, a] of Object.entries(story.assets)) if (a.type === "cg" && a.gallery) galleryDeclared.push(k);

    for (const [id, n] of Object.entries(story.nodes)) {
      const p = "nodes." + id;
      if (!ident(id)) error(p, "不安全的节点 ID");
      if (!keys(n, ALLOW.node, p)) continue;
      text(n.title, p + ".title");
      ["chapter", "location", "notes"].forEach(t => optText(n[t], p + "." + t));
      assetRef(n.background, ["background"], p + ".background");
      assetRef(n.bgm, ["bgm"], p + ".bgm");
      assetRef(n.sfx, ["sfx"], p + ".sfx");
      if (own(n, "transition") && !["fade", "cut", "slide", "flash", "none"].includes(n.transition))
        error(p + ".transition", "未知转场");

      for (const id2 of n.unlocks || []) { cgRef(id2, p + ".unlocks"); usedCg.add(id2); }
      for (const id2 of n.awards || []) {
        if (!own(story.achievements, id2)) error(p + ".awards", "成就未定义: " + id2);
        usedAch.add(id2);
      }

      /* cast */
      if (own(n, "cast")) {
        if (!Array.isArray(n.cast)) error(p + ".cast", "须为数组");
        else n.cast.forEach((c, i) => {
          const cp = p + ".cast[" + i + "]";
          if (!keys(c, ALLOW.cast, cp)) return;
          if (!own(story.characters, c.who)) error(cp, "角色不存在");
          if (own(c, "at") && !["left", "center", "right", "far-left", "far-right"].includes(c.at))
            error(cp, "at 取值非法");
          if (own(c, "scale") && (!Number.isFinite(c.scale) || c.scale < 0.6 || c.scale > 1.4))
            error(cp, "scale 须在 0.6–1.4");
          if (own(c, "emotion") && own(story.characters, c.who) &&
            !own(story.characters[c.who].portraits || {}, c.emotion))
            warnings.push(cp + ": 角色缺少该情绪立绘，运行时回落到 default");
        });
      }

      /* intimacy */
      if (own(n, "intimacy")) {
        const ip = p + ".intimacy";
        if (keys(n.intimacy, ALLOW.intimacy, ip)) {
          const it = n.intimacy;
          if (!["suggestive", "adult"].includes(it.tier)) error(ip + ".tier", "须为 suggestive / adult");
          if (!STAGES.includes(it.stage)) error(ip + ".stage", "未知 stage");
          if (it.consent !== "mutual") error(ip + ".consent", "必须为 mutual");
          if (!Array.isArray(it.partners) || !it.partners.length ||
            it.partners.some(x => !own(story.characters, x))) error(ip + ".partners", "须为已声明角色数组");
          for (const pid of it.partners || [])
            if (own(story.characters, pid) && (!Number.isInteger(story.characters[pid].age) || story.characters[pid].age < 18))
              error(ip + ".partners", "亲密场景参与者必须 ≥18 岁: " + pid);
          if (tier === "all") error(ip, "contentTier=all 的作品不允许 intimacy 节点");
          else if (tier && it.tier === "adult" && tier !== "adult")
            error(ip + ".tier", "adult 亲密节点不允许出现在 contentTier=" + tier + " 的作品中");
        }
      }

      /* segments */
      if (!Array.isArray(n.segments) || !n.segments.length) error(p, "至少一段正文");
      else n.segments.forEach((s, i) => {
        const sp = p + ".segments[" + i + "]";
        if (!keys(s, ALLOW.seg, sp)) return;
        text(s.text, sp + ".text");
        checkCondition(s.when, sp + ".when");
        if (s.speaker !== undefined && !own(story.characters, s.speaker)) error(sp, "speaker 不存在");
        assetRef(s.sfx, ["sfx"], sp + ".sfx");
        if (typeof s.text === "string" && /\[(TODO|待补充)\]|（省略）/.test(s.text))
          error(sp, "禁止占位正文");
      });

      const modes = ["choices", "next", "routes", "ending"].filter(k2 => own(n, k2));
      if (modes.length !== 1) error(p, "choices / next / routes / ending 必须且只能选一种（当前 " + modes.length + " 种）");

      if (own(n, "choices")) {
        if (!Array.isArray(n.choices) || !n.choices.length) error(p + ".choices", "不可为空");
        else {
          const ids = new Set();
          n.choices.forEach((c, i) => {
            const cp = p + ".choices[" + i + "]";
            if (!keys(c, ALLOW.choice, cp)) return;
            if (!ident(c.id) || ids.has(c.id)) error(cp, "choice.id 非法或重复");
            ids.add(c.id);
            text(c.text, cp + ".text");
            ref(c.next, cp + ".next");
            checkCondition(c.when, cp + ".when");
            effects(c.effects, cp + ".effects");
            ["feedback", "lockedReason", "hint"].forEach(t => optText(c[t], cp + "." + t));
            if (n.choices.length > 1 && !c.feedback) warnings.push(cp + ": 建议补一段独立的即时反馈");
          });
        }
      }
      if (own(n, "next")) ref(n.next, p + ".next");
      if (own(n, "routes")) {
        if (!Array.isArray(n.routes) || !n.routes.length) error(p + ".routes", "不可为空");
        else n.routes.forEach((r, i) => {
          const rp = p + ".routes[" + i + "]";
          if (!keys(r, ["when", "next"], rp)) return;
          ref(r.next, rp + ".next");
          checkCondition(r.when, rp + ".when");
          if (i === n.routes.length - 1 && own(r, "when")) error(rp, "最后一项必须无 when 作兜底");
          if (i < n.routes.length - 1 && !own(r, "when")) error(rp, "兜底只能在末项");
        });
      }
      if (own(n, "ending")) {
        const ep = p + ".ending";
        if (!keys(n.ending, ALLOW.ending, ep)) { /* reported above */ }
        else {
          ["id", "name", "kind", "summary"].forEach(t => text(n.ending[t], ep + "." + t));
          if (!ident(n.ending.id) || endings.has(n.ending.id)) error(ep + ".id", "非法或重复");
          endings.add(n.ending.id);
          if (own(n.ending, "tier") && !TIERS.includes(n.ending.tier)) error(ep + ".tier", "分级非法");
          for (const id2 of n.ending.unlockCg || []) { cgRef(id2, ep + ".unlockCg"); usedCg.add(id2); }
        }
      }
    }

    for (const [k, c] of Object.entries(story.characters))
      for (const [emo, aid] of Object.entries(c.portraits || {}))
        assetRef(aid, ["portrait"], "characters." + k + ".portraits." + emo);

    for (const id of galleryDeclared) if (!usedCg.has(id)) warnings.push("assets." + id + ": 声明进画廊但从未被任何节点解锁");
    for (const id of Object.keys(story.achievements)) if (!usedAch.has(id)) warnings.push("achievements." + id + ": 定义了但从未被授予");
    if (!endings.size) error("nodes", "至少需要 1 个结局");

    return { errors, warnings };
  }

  /* --------------------------------------------------------------- analyze */

  function readVarsOfStory(story) {
    const set = new Set();
    const walk = (c) => {
      if (!object(c)) return;
      ([] .concat(Array.isArray(c.all) ? c.all : [], Array.isArray(c.any) ? c.any : [])).forEach(walk);
      if (own(c, "not")) walk(c.not);
      if (own(c, "var")) set.add(c.var);
    };
    for (const n of Object.values(story.nodes)) {
      (n.segments || []).forEach(s => walk(s.when));
      (n.choices || []).forEach(c => walk(c.when));
      (n.routes || []).forEach(r => walk(r.when));
    }
    return set;
  }

  function analyze(story, limit) {
    limit = limit || 100000;
    const checked = validate(story);
    const readSet = checked.errors.length ? null : readVarsOfStory(story);
    if (readSet)
      for (const k of Object.keys(story.variables))
        if (!readSet.has(k) && story.variables[k].type !== "int" && !story.variables[k].visible)
          checked.warnings.push("variables." + k + ": 从未被任何 when 读取（可能写错变量名）");

    const report = {
      ...checked, complete: false, states: 0, nodes: 0, endings: {},
      unreachableNodes: [], unreachableChoices: [], softlocks: [], hasCycles: false
    };
    if (checked.errors.length) return report;

    const order = Object.keys(story.variables).sort();
    const key = s => JSON.stringify([s.node, ...order.map(k => s.vars[k])]);
    const start = initial(story);
    const records = [{ state: start, prev: -1, via: null }];
    const lookup = new Map([[key(start), 0]]);
    const reverse = [[]], forward = [[]];
    const seenNodes = new Set(), seenEdges = new Set(), endingStates = [];
    let truncated = false;

    function pathTo(i) {
      const steps = [];
      while (records[i].prev >= 0) { steps.push(records[i].via); i = records[i].prev; }
      return steps.reverse();
    }

    for (let i = 0; i < records.length; i++) {
      const s = records[i].state, n = story.nodes[s.node];
      seenNodes.add(s.node);
      if (n.ending) {
        endingStates.push(i);
        if (!own(report.endings, n.ending.id))
          report.endings[n.ending.id] = { name: n.ending.name, node: s.node, steps: pathTo(i) };
      }
      if (!visibleSegments(story, s).length) report.errors.push("正文完全被条件隐藏: " + s.node);
      const nexts = edges(story, s);
      if (!n.ending && !nexts.length)
        report.softlocks.push({ node: s.node, vars: s.vars, steps: pathTo(i), reason: "没有可选出口" });
      for (const e of nexts) {
        seenEdges.add(s.node + "/" + e.key);
        const ns = step(story, s, e.key), k = key(ns);
        let j = lookup.get(k);
        if (j === undefined) {
          if (records.length >= limit) { truncated = true; continue; }
          j = records.length;
          lookup.set(k, j);
          records.push({ state: ns, prev: i, via: e.key });
          reverse.push([]); forward.push([]);
        }
        reverse[j].push(i); forward[i].push(j);
      }
    }

    report.complete = !truncated;
    report.states = records.length;
    report.nodes = seenNodes.size;
    report.unreachableNodes = Object.keys(story.nodes).filter(k => !seenNodes.has(k));
    for (const [id, n] of Object.entries(story.nodes))
      for (const c of n.choices || [])
        if (!seenEdges.has(id + "/" + c.id)) report.unreachableChoices.push(id + "/" + c.id);

    if (truncated) {
      report.errors.push("状态探索达到上限 " + limit + "：结论不完整，不可标记全路线验证通过");
    } else {
      const canEnd = new Set(endingStates), queue = endingStates.slice();
      for (let i = 0; i < queue.length; i++)
        for (const prev of reverse[queue[i]]) if (!canEnd.has(prev)) { canEnd.add(prev); queue.push(prev); }
      const trapped = records.findIndex((r, i) => !canEnd.has(i));
      if (trapped >= 0)
        report.softlocks.push({
          node: records[trapped].state.node, vars: records[trapped].state.vars,
          steps: pathTo(trapped), reason: "此状态无任何路径可到达结局"
        });
      const indegree = reverse.map(x => x.length), zero = [];
      indegree.forEach((n, i) => { if (n === 0) zero.push(i); });
      for (let i = 0; i < zero.length; i++)
        for (const j of forward[zero[i]]) if (--indegree[j] === 0) zero.push(j);
      report.hasCycles = zero.length !== records.length;
      if (report.hasCycles) report.warnings.push("含可循环玩法；已检查各状态存在结局出口，但玩家仍可主动反复刷同一段");
      if (report.unreachableNodes.length) report.errors.push("不可达节点: " + report.unreachableNodes.join(", "));
      if (report.unreachableChoices.length) report.warnings.push("永不可用选项: " + report.unreachableChoices.join(", "));
      if (report.softlocks.length) report.errors.push("发现软锁状态，详见 softlocks 与复现 steps");
    }
    return report;
  }

  /* ------------------------------------------------------------------ lint */

  const BANNED = ["突然", "只见", "仿佛", "似乎", "不禁", "莫名", "下意识", "一丝", "某种",
    "命运的齿轮", "时间仿佛静止", "不知为何", "命运的安排"];

  function lint(story, maxPerSegment) {
    maxPerSegment = maxPerSegment || 80;
    const out = [];
    for (const [id, n] of Object.entries(story.nodes || {})) {
      (n.segments || []).forEach((s, i) => {
        const t = s.text || "";
        if (t.length > maxPerSegment) out.push({ where: id + ".segments[" + i + "]", issue: "段落过长 " + t.length + " 字", fix: "切成两段" });
        BANNED.forEach(w => { if (t.includes(w)) out.push({ where: id + ".segments[" + i + "]", issue: "疑似陈词「" + w + "」", fix: "换成具体动作或可见的物" }); });
      });
      for (const c of n.choices || [])
        if ((c.text || "").length > 16) out.push({ where: id + "/" + c.id, issue: "选项过长 " + (c.text || "").length + " 字", fix: "动词开头，≤12 字" });
    }
    return out;
  }

  return { clone, condition, initial, apply, edges, step, visibleSegments, replay, collect, stamp, validate, analyze, lint };
});
