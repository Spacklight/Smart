// Smartbase SQL engine (tastdone): pure JS, zero dependencies, runs in Node and Cloudflare Workers.
class SQLError extends Error {}
const fail = (m) => { throw new SQLError(m); };

/* ---------------- tokenizer ---------------- */
function tokenize(sql) {
  const t = [], n = sql.length; let i = 0, st0 = 0, cnt = 0;
  for (;;) {
    if (t.length > cnt) { t[t.length - 1].s = st0; t[t.length - 1].e = i; cnt = t.length; }
    if (i >= n) break;
    st0 = i; const c = sql[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '-' && sql[i + 1] === '-') { while (i < n && sql[i] !== '\n') i++; continue; }
    if (c === '#') { while (i < n && sql[i] !== '\n') i++; continue; }
    if (c === '/' && sql[i + 1] === '*') { const e = sql.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    if (c === "'") { let s = ''; i++; while (i < n) { if (sql[i] === "'") { if (sql[i + 1] === "'") { s += "'"; i += 2; continue; } break; } if (sql[i] === '\\' && i + 1 < n) { const x = sql[i + 1]; s += x === 'n' ? '\n' : x === 't' ? '\t' : x; i += 2; continue; } s += sql[i++]; } i++; t.push({ t: 'str', v: s }); continue; }
    if (c === '"' || c === '`' || c === '[') { const q = c === '[' ? ']' : c; let s = ''; i++; while (i < n && sql[i] !== q) s += sql[i++]; i++; t.push({ t: 'id', v: s, q: 1 }); continue; }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(sql[i + 1] || ''))) { const m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(sql.slice(i, i + 40)); t.push({ t: 'num', v: parseFloat(m[0]) }); i += m[0].length; continue; }
    if (/[A-Za-z_]/.test(c)) { const m = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(sql.slice(i, i + 200)); t.push({ t: 'id', v: m[0] }); i += m[0].length; continue; }
    const two = sql.substr(i, 2);
    if (['<=', '>=', '<>', '!=', '==', '||'].includes(two)) { t.push({ t: 'op', v: two }); i += 2; continue; }
    if (c === ';') { t.push({ t: ';' }); i++; continue; }
    t.push({ t: 'op', v: c }); i++;
  }
  return t;
}

/* ---------------- parser ---------------- */
const RESERVED = new Set('FROM WHERE GROUP HAVING ORDER LIMIT OFFSET UNION INTERSECT EXCEPT JOIN INNER LEFT RIGHT FULL CROSS ON USING SET VALUES SELECT AND OR NOT AS WHEN THEN ELSE END IS IN LIKE BETWEEN WITH'.split(' '));
const CONS = new Set('PRIMARY NOT NULL UNIQUE DEFAULT CHECK REFERENCES AUTO_INCREMENT AUTOINCREMENT COLLATE CONSTRAINT GENERATED COMMENT'.split(' '));

class Parser {
  constructor(sql) { this.src = sql; this.tk = tokenize(sql); this.p = 0; }
  get cur() { return this.tk[this.p]; }
  up(o = 0) { const t = this.tk[this.p + o]; return t && t.t === 'id' && !t.q ? t.v.toUpperCase() : null; }
  kw(w) { if (this.up() === w) { this.p++; return true; } return false; }
  need(w) { if (!this.kw(w)) this.err('Expected ' + w); }
  isOp(v, o = 0) { const t = this.tk[this.p + o]; return !!t && t.t === 'op' && t.v === v; }
  op(v) { if (this.isOp(v)) { this.p++; return true; } return false; }
  needOp(v) { if (!this.op(v)) this.err("Expected '" + v + "'"); }
  err(m) { const t = this.cur; fail('Syntax error: ' + m + (t ? " near '" + this.src.slice(t.s, t.e) + "'" : ' at end of input')); }
  ident() { const t = this.cur; if (!t || t.t !== 'id') this.err('Expected identifier'); this.p++; return t.v; }
  nameList() { this.needOp('('); const a = []; do { a.push(this.ident().toLowerCase()); this.kw('ASC') || this.kw('DESC'); } while (this.op(',')); this.needOp(')'); return a; }
  skipParen() { let d = 0; do { if (this.isOp('(')) d++; else if (this.isOp(')')) d--; this.p++; } while (d > 0 && this.cur); }
  ifne() { if (this.up() === 'IF' && this.up(1) === 'NOT') { this.p += 3; return true; } return false; }
  ife() { if (this.up() === 'IF' && this.up(1) === 'EXISTS') { this.p += 2; return true; } return false; }

  script() { const out = []; while (this.cur) { if (this.cur.t === ';') { this.p++; continue; } out.push(this.stmt()); if (this.cur && this.cur.t !== ';') this.err('Unexpected token'); } return out; }
  stmt() {
    switch (this.up()) {
      case 'SELECT': case 'WITH': return { s: 'select', q: this.query() };
      case 'INSERT': case 'REPLACE': return this.insert();
      case 'UPDATE': return this.update();
      case 'DELETE': return this.del();
      case 'CREATE': return this.create();
      case 'DROP': return this.drop();
      case 'ALTER': return this.alter();
      case 'TRUNCATE': this.p++; this.kw('TABLE'); return { s: 'truncate', t: this.ident() };
      case 'BEGIN': case 'START': this.p++; this.kw('TRANSACTION') || this.kw('WORK'); return { s: 'begin' };
      case 'COMMIT': case 'END': this.p++; return { s: 'commit' };
      case 'ROLLBACK': this.p++; return { s: 'rollback' };
      case 'USE': this.p++; this.ident(); return { s: 'noop', msg: 'OK' };
      case 'SHOW': this.p++; if (this.kw('TABLES')) return { s: 'show' }; if (this.kw('COLUMNS') || this.kw('FIELDS')) { this.kw('FROM') || this.kw('IN'); return { s: 'describe', t: this.ident() }; } this.err('Unsupported SHOW');
      case 'DESCRIBE': case 'DESC': this.p++; return { s: 'describe', t: this.ident() };
      case 'PRAGMA': this.p++; if (this.ident().toLowerCase() === 'table_info') { this.needOp('('); const t = this.ident(); this.needOp(')'); return { s: 'describe', t, pragma: true }; } return { s: 'noop', msg: 'OK' };
    }
    this.err('Unsupported statement');
  }
  query() {
    const ctes = [];
    if (this.kw('WITH')) { this.kw('RECURSIVE'); do { const name = this.ident(); let cols = null; if (this.op('(')) { cols = []; do cols.push(this.ident()); while (this.op(',')); this.needOp(')'); } this.need('AS'); this.needOp('('); const q = this.query(); this.needOp(')'); ctes.push({ name, cols, q }); } while (this.op(',')); }
    const parts = [this.core()], ops = [];
    for (;;) { let o; if (this.kw('UNION')) o = this.kw('ALL') ? 'UNION ALL' : 'UNION'; else if (this.kw('INTERSECT')) o = 'INTERSECT'; else if (this.kw('EXCEPT')) o = 'EXCEPT'; else break; ops.push(o); parts.push(this.core()); }
    const q = { ctes, parts, ops };
    if (this.kw('ORDER')) { this.need('BY'); q.order = []; do { const e = this.expr(); let d = false; if (this.kw('DESC')) d = true; else this.kw('ASC'); let nf = null; if (this.kw('NULLS')) nf = this.kw('FIRST') ? 'f' : (this.need('LAST'), 'l'); q.order.push({ e, d, nf }); } while (this.op(',')); }
    if (this.kw('LIMIT')) { q.limit = this.expr(); if (this.kw('OFFSET')) q.offset = this.expr(); else if (this.op(',')) { q.offset = q.limit; q.limit = this.expr(); } }
    else if (this.kw('OFFSET')) q.offset = this.expr();
    return q;
  }
  core() {
    this.need('SELECT'); const c = { items: [] };
    if (this.kw('DISTINCT')) c.distinct = true; else this.kw('ALL');
    do {
      if (this.isOp('*')) { this.p++; c.items.push({ star: true }); }
      else if (this.cur && this.cur.t === 'id' && this.isOp('.', 1) && this.isOp('*', 2)) { const t = this.ident(); this.p += 2; c.items.push({ star: true, t: t.toLowerCase() }); }
      else {
        const a = this.p, e = this.expr(); const label = e.k === 'col' ? e.n : this.src.slice(this.tk[a].s, this.tk[this.p - 1].e);
        let alias = null;
        if (this.kw('AS')) alias = this.aliasName(); else if (this.cur && this.cur.t === 'id' && (this.cur.q || !RESERVED.has(this.up()))) alias = this.ident();
        c.items.push({ expr: e, alias, label });
      }
    } while (this.op(','));
    if (this.kw('FROM')) c.from = this.from();
    if (this.kw('WHERE')) c.where = this.expr();
    if (this.kw('GROUP')) { this.need('BY'); c.group = []; do c.group.push(this.expr()); while (this.op(',')); }
    if (this.kw('HAVING')) c.having = this.expr();
    return c;
  }
  aliasName() { const t = this.cur; if (t && t.t === 'str') { this.p++; return t.v; } return this.ident(); }
  from() {
    const first = this.source(), joins = [];
    for (;;) {
      let type = null;
      if (this.op(',')) type = 'CROSS';
      else {
        const save = this.p;
        if (this.kw('INNER')) type = 'INNER'; else if (this.kw('CROSS')) type = 'CROSS'; else if (this.kw('LEFT')) { this.kw('OUTER'); type = 'LEFT'; } else if (this.kw('RIGHT')) { this.kw('OUTER'); type = 'RIGHT'; } else if (this.kw('FULL')) { this.kw('OUTER'); type = 'FULL'; }
        if (this.kw('JOIN')) type = type || 'INNER'; else if (type) this.err('Expected JOIN'); else { this.p = save; break; }
      }
      const j = { type, src: this.source() };
      if (this.kw('ON')) j.on = this.expr();
      else if (this.kw('USING')) { j.using = this.nameList(); }
      joins.push(j);
    }
    return { first, joins };
  }
  source() {
    let s;
    if (this.isOp('(')) { this.p++; const q = this.query(); this.needOp(')'); s = { kind: 'sub', q }; } else s = { kind: 'table', name: this.ident() };
    if (this.kw('AS')) s.alias = this.ident(); else if (this.cur && this.cur.t === 'id' && (this.cur.q || !RESERVED.has(this.up()))) s.alias = this.ident();
    if (s.kind === 'sub' && !s.alias) s.alias = 'sub';
    return s;
  }
  assigns() { const a = []; do { let c = this.ident(); if (this.op('.')) c = this.ident(); this.needOp('='); a.push([c, this.expr()]); } while (this.op(',')); return a; }
  insert() {
    const st = { s: 'insert' };
    if (this.kw('REPLACE')) st.replace = true;
    else { this.need('INSERT'); if (this.kw('OR')) { if (this.kw('REPLACE')) st.replace = true; else { this.need('IGNORE'); st.ignore = true; } } else if (this.kw('IGNORE')) st.ignore = true; }
    this.kw('INTO'); st.t = this.ident();
    if (this.isOp('(')) { this.p++; st.cols = []; do st.cols.push(this.ident()); while (this.op(',')); this.needOp(')'); }
    if (this.kw('VALUES') || this.kw('VALUE')) { st.values = []; do { this.needOp('('); const r = []; if (!this.isOp(')')) do r.push(this.expr()); while (this.op(',')); this.needOp(')'); st.values.push(r); } while (this.op(',')); }
    else if (this.kw('DEFAULT')) { this.need('VALUES'); st.values = [[]]; st.cols = []; }
    else st.q = this.query();
    if (this.kw('ON')) {
      if (this.kw('DUPLICATE')) { this.need('KEY'); this.need('UPDATE'); st.upd = this.assigns(); }
      else { this.need('CONFLICT'); if (this.isOp('(')) this.skipParen(); this.need('DO'); if (this.kw('NOTHING')) st.ignore = true; else { this.need('UPDATE'); this.need('SET'); st.upd = this.assigns(); } }
    }
    return st;
  }
  update() { this.need('UPDATE'); const t = this.ident(); this.need('SET'); const st = { s: 'update', t, sets: this.assigns() }; if (this.kw('WHERE')) st.where = this.expr(); return st; }
  del() { this.need('DELETE'); this.need('FROM'); const st = { s: 'delete', t: this.ident() }; if (this.kw('WHERE')) st.where = this.expr(); return st; }
  create() {
    this.need('CREATE'); this.kw('TEMP') || this.kw('TEMPORARY'); const uniq = this.kw('UNIQUE');
    if (this.kw('INDEX')) { const ine = this.ifne(); const name = this.ident(); this.need('ON'); const t = this.ident(); return { s: 'index', name, t, cols: this.nameList(), uniq, ine }; }
    if (this.kw('VIEW')) { const ine = this.ifne(); const name = this.ident(); this.need('AS'); const a = this.p; this.query(); return { s: 'view', name, ine, sql: this.src.slice(this.tk[a].s, this.tk[this.p - 1].e) }; }
    if (this.kw('DATABASE') || this.kw('SCHEMA')) return { s: 'noop', msg: 'Use the dashboard to create databases' };
    this.need('TABLE'); const ine = this.ifne(); const name = this.ident();
    if (this.kw('AS')) return { s: 'ctas', name, ine, q: this.query() };
    this.needOp('('); const cols = [], pk = [], uniques = [], checks = [];
    do {
      if (this.up() === 'CONSTRAINT') this.p += 2;
      const w = this.up();
      if (w === 'PRIMARY') { this.p += 2; pk.push(...this.nameList()); }
      else if (w === 'UNIQUE') { this.p++; this.kw('KEY') || this.kw('INDEX'); if (!this.isOp('(')) this.ident(); uniques.push({ keys: this.nameList() }); }
      else if (w === 'CHECK') { this.p++; this.needOp('('); checks.push(this.expr()); this.needOp(')'); }
      else if ((w === 'FOREIGN' && this.up(1) === 'KEY') || ((w === 'KEY' || w === 'INDEX' || w === 'FULLTEXT') && (this.isOp('(', 1) || this.isOp('(', 2)))) { let d = 0; while (this.cur && !(d === 0 && (this.isOp(',') || this.isOp(')')))) { if (this.isOp('(')) d++; if (this.isOp(')')) d--; this.p++; } }
      else cols.push(this.colDef());
    } while (this.op(','));
    this.needOp(')'); while (this.cur && this.cur.t !== ';') this.p++;
    return { s: 'create', name, ine, cols, pk, uniques, checks };
  }
  colDef() {
    const name = this.ident(); const c = { name, key: name.toLowerCase(), type: '' }; const parts = [];
    while (this.cur && this.cur.t === 'id' && !this.cur.q && !CONS.has(this.up())) { parts.push(this.ident()); if (this.isOp('(')) this.skipParen(); }
    c.type = parts.join(' ');
    for (;;) {
      if (this.kw('PRIMARY')) { this.need('KEY'); c.pk = true; this.kw('ASC') || this.kw('DESC'); }
      else if (this.kw('NOT')) { this.need('NULL'); c.notnull = true; }
      else if (this.kw('NULL')) { }
      else if (this.kw('UNIQUE')) { this.kw('KEY'); c.unique = true; }
      else if (this.kw('AUTO_INCREMENT') || this.kw('AUTOINCREMENT')) c.auto = true;
      else if (this.kw('DEFAULT')) { const a = this.p; c.def = this.unary(); c.defText = this.src.slice(this.tk[a].s, this.tk[this.p - 1].e); }
      else if (this.kw('CHECK')) { this.needOp('('); c.check = this.expr(); this.needOp(')'); }
      else if (this.kw('REFERENCES')) { this.ident(); if (this.isOp('(')) this.skipParen(); while (this.kw('ON')) { this.p++; if (this.kw('SET') || this.kw('NO')) this.p++; else this.p++; } }
      else if (this.kw('COLLATE')) this.ident();
      else if (this.kw('COMMENT')) this.p++;
      else break;
    }
    return c;
  }
  drop() {
    this.need('DROP'); const w = this.up(); this.p++;
    if (w === 'TABLE' || w === 'VIEW') { const ie = this.ife(); const names = []; do names.push(this.ident()); while (this.op(',')); return { s: w === 'TABLE' ? 'drop' : 'dropview', names, ie }; }
    if (w === 'INDEX') { const ie = this.ife(); const name = this.ident(); if (this.kw('ON')) this.ident(); return { s: 'dropindex', name, ie }; }
    this.err('Unsupported DROP');
  }
  alter() {
    this.need('ALTER'); this.need('TABLE'); const t = this.ident();
    if (this.kw('ADD')) { this.kw('COLUMN'); return { s: 'alter', t, a: 'add', col: this.colDef() }; }
    if (this.kw('DROP')) { this.kw('COLUMN'); return { s: 'alter', t, a: 'drop', name: this.ident() }; }
    if (this.kw('RENAME')) { if (this.kw('COLUMN')) { const f = this.ident(); this.need('TO'); return { s: 'alter', t, a: 'rencol', from: f, to: this.ident() }; } this.kw('TO'); return { s: 'alter', t, a: 'rename', to: this.ident() }; }
    this.err('Unsupported ALTER');
  }
  /* expressions */
  expr() { return this.or(); }
  or() { let l = this.and(); while (this.kw('OR')) l = { k: 'bin', op: 'OR', l, r: this.and() }; return l; }
  and() { let l = this.not(); while (this.kw('AND')) l = { k: 'bin', op: 'AND', l, r: this.not() }; return l; }
  not() { if (this.kw('NOT')) return { k: 'un', op: 'NOT', e: this.not() }; return this.cmp(); }
  cmp() {
    let l = this.add();
    for (;;) {
      let not = false;
      if (this.up() === 'NOT' && ['IN', 'BETWEEN', 'LIKE', 'GLOB', 'REGEXP'].includes(this.up(1))) { this.p++; not = true; }
      if (this.kw('IS')) { const n = this.kw('NOT'); if (this.kw('NULL')) { l = { k: 'isnull', e: l, not: n }; continue; } l = { k: 'bin', op: n ? 'ISNOT' : 'IS', l, r: this.add() }; continue; }
      if (this.kw('IN')) { this.needOp('('); const n = { k: 'in', e: l, not }; if (this.up() === 'SELECT' || this.up() === 'WITH') n.q = this.query(); else { n.list = []; if (!this.isOp(')')) do n.list.push(this.expr()); while (this.op(',')); } this.needOp(')'); l = n; continue; }
      if (this.kw('BETWEEN')) { const a = this.add(); this.need('AND'); l = { k: 'between', e: l, a, b: this.add(), not }; continue; }
      if (this.kw('LIKE') || this.kw('GLOB')) { l = { k: 'like', e: l, p: this.add(), not }; continue; }
      if (this.kw('REGEXP')) { l = { k: 'regexp', e: l, p: this.add(), not }; continue; }
      const t = this.cur;
      if (t && t.t === 'op' && ['=', '==', '<>', '!=', '<', '>', '<=', '>='].includes(t.v)) { this.p++; l = { k: 'bin', op: t.v, l, r: this.add() }; continue; }
      return l;
    }
  }
  add() { let l = this.mul(); for (;;) { const t = this.cur; if (t && t.t === 'op' && ['+', '-', '||'].includes(t.v)) { this.p++; l = { k: 'bin', op: t.v, l, r: this.mul() }; } else return l; } }
  mul() { let l = this.unary(); for (;;) { const t = this.cur; if (t && t.t === 'op' && ['*', '/', '%'].includes(t.v)) { this.p++; l = { k: 'bin', op: t.v, l, r: this.unary() }; } else return l; } }
  unary() { if (this.op('-')) return { k: 'un', op: '-', e: this.unary() }; if (this.op('+')) return this.unary(); return this.primary(); }
  primary() {
    const t = this.cur; if (!t) this.err('Unexpected end of input');
    if (t.t === 'num' || t.t === 'str') { this.p++; return { k: 'lit', v: t.v }; }
    if (t.t === 'op' && t.v === '(') { this.p++; if (this.up() === 'SELECT' || this.up() === 'WITH') { const q = this.query(); this.needOp(')'); return { k: 'sub', q }; } const e = this.expr(); this.needOp(')'); return e; }
    if (t.t === 'id') {
      const w = this.up();
      if (w) {
        if (w === 'NULL') { this.p++; return { k: 'lit', v: null }; }
        if (w === 'TRUE') { this.p++; return { k: 'lit', v: 1 }; }
        if (w === 'FALSE') { this.p++; return { k: 'lit', v: 0 }; }
        if (w === 'DEFAULT' && !this.isOp('(', 1)) { this.p++; return { k: 'default' }; }
        if (w === 'CASE') { this.p++; const c = { k: 'case', whens: [] }; if (this.up() !== 'WHEN') c.base = this.expr(); while (this.kw('WHEN')) { const x = this.expr(); this.need('THEN'); c.whens.push([x, this.expr()]); } if (this.kw('ELSE')) c.els = this.expr(); this.need('END'); return c; }
        if (w === 'CAST') { this.p++; this.needOp('('); const e = this.expr(); this.need('AS'); const ty = this.ident(); if (this.isOp('(')) this.skipParen(); this.needOp(')'); return { k: 'cast', e, ty }; }
        if (w === 'EXISTS') { this.p++; this.needOp('('); const q = this.query(); this.needOp(')'); return { k: 'exists', q }; }
        if (w === 'CURRENT_TIMESTAMP' || w === 'CURRENT_DATE' || w === 'CURRENT_TIME') { this.p++; return { k: 'fn', name: w, args: [] }; }
      }
      this.p++;
      if (this.isOp('(') && !t.q) {
        this.p++; const f = { k: 'fn', name: t.v.toUpperCase(), args: [] };
        if (this.isOp('*')) { this.p++; f.star = true; }
        else if (!this.isOp(')')) { if (this.kw('DISTINCT')) f.distinct = true; do f.args.push(this.expr()); while (this.op(',')); if (this.kw('SEPARATOR')) { f.sep = this.cur.v; this.p++; } }
        this.needOp(')'); return f;
      }
      if (this.op('.')) { const n = this.ident(); return { k: 'col', t: t.v.toLowerCase(), n }; }
      return { k: 'col', n: t.v };
    }
    this.err('Unexpected token');
  }
}

/* ---------------- values & helpers ---------------- */
const EMPTY = { t: {}, m: [] };
const AGG = new Set(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'TOTAL', 'GROUP_CONCAT', 'STRING_AGG']);
const isAggNode = (n) => AGG.has(n.name) && !((n.name === 'MIN' || n.name === 'MAX') && n.args.length > 1);
function isAgg(n) {
  if (!n || typeof n !== 'object') return false;
  if (Array.isArray(n)) return n.some(isAgg);
  if (n.k === 'fn' && isAggNode(n)) return true;
  if (n.k === 'sub' || n.k === 'exists') return false;
  for (const k in n) { if (k === 'q') continue; if (isAgg(n[k])) return true; }
  return false;
}
const truthy = (v) => v != null && v !== false && Number(v) !== 0;
const num = (v) => { const x = Number(v); return isNaN(x) ? 0 : x; };
function cmp(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  const x = Number(a), y = Number(b);
  if (!isNaN(x) && !isNaN(y) && a !== '' && b !== '') return x < y ? -1 : x > y ? 1 : 0;
  a = String(a); b = String(b); return a < b ? -1 : a > b ? 1 : 0;
}
const likeRe = (p) => new RegExp('^' + String(p).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.') + '$', 'is');
function coerce(v, type) {
  if (v == null) return null; const t = (type || '').toUpperCase();
  if (/INT/.test(t)) { const n = Number(v); return isNaN(n) ? v : Math.trunc(n); }
  if (/REAL|FLOA|DOUB|DEC|NUM/.test(t)) { const n = Number(v); return isNaN(n) ? v : n; }
  if (/CHAR|TEXT|CLOB|STRING/.test(t)) return String(v);
  if (/BOOL/.test(t)) return v === true || v === 'true' ? 1 : v === false || v === 'false' ? 0 : v;
  return v;
}
const S = (f) => (a) => (a[0] == null ? null : f(...a));
const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const FN = {
  UPPER: S((s) => String(s).toUpperCase()), LOWER: S((s) => String(s).toLowerCase()),
  LENGTH: S((s) => String(s).length), TRIM: S((s) => String(s).trim()), LTRIM: S((s) => String(s).trimStart()), RTRIM: S((s) => String(s).trimEnd()),
  REVERSE: S((s) => [...String(s)].reverse().join('')),
  SUBSTR: S((s, st, l) => { s = String(s); st = Number(st); const i = st > 0 ? st - 1 : st < 0 ? Math.max(s.length + st, 0) : 0; return l == null ? s.slice(i) : s.substr(i, Math.max(Number(l), 0)); }),
  REPLACE: S((s, a, b) => String(s).split(String(a)).join(String(b))),
  INSTR: S((s, x) => String(s).indexOf(String(x)) + 1), LEFT: S((s, n) => String(s).slice(0, n)), RIGHT: S((s, n) => (n > 0 ? String(s).slice(-n) : '')),
  LPAD: S((s, n, p = ' ') => String(s).padStart(n, p)), RPAD: S((s, n, p = ' ') => String(s).padEnd(n, p)),
  CONCAT: (a) => (a.some((x) => x == null) ? null : a.join('')), CONCAT_WS: (a) => a.slice(1).filter((x) => x != null).join(a[0]),
  ABS: S(Math.abs), CEIL: S(Math.ceil), FLOOR: S(Math.floor), SQRT: S(Math.sqrt), EXP: S(Math.exp), LN: S(Math.log), SIGN: S(Math.sign),
  ROUND: S((x, d = 0) => { const m = 10 ** d; return Math.round(x * m) / m; }), POWER: S((a, b) => a ** b), MOD: S((a, b) => (Number(b) === 0 ? null : a % b)),
  COALESCE: (a) => { const v = a.find((x) => x != null); return v === undefined ? null : v; },
  NULLIF: (a) => (cmp(a[0], a[1]) === 0 ? null : a[0]), IIF: (a) => (truthy(a[0]) ? a[1] : a[2]),
  NOW: now, CURRENT_TIMESTAMP: now, CURRENT_DATE: () => now().slice(0, 10), CURRENT_TIME: () => now().slice(11),
  DATE: (a) => (a[0] == null && a.length ? null : String(a.length ? a[0] : now()).slice(0, 10)),
  YEAR: S((d) => +String(d).slice(0, 4)), MONTH: S((d) => +String(d).slice(5, 7)), DAY: S((d) => +String(d).slice(8, 10)),
  RANDOM: () => Math.floor(Math.random() * 2 ** 31), RAND: () => Math.random(),
  UUID: () => crypto.randomUUID(), TYPEOF: (a) => (a[0] == null ? 'null' : typeof a[0] === 'number' ? (Number.isInteger(a[0]) ? 'integer' : 'real') : 'text'),
  GREATEST: (a) => (a.some((x) => x == null) ? null : a.reduce((x, y) => (cmp(x, y) >= 0 ? x : y))),
  LEAST: (a) => (a.some((x) => x == null) ? null : a.reduce((x, y) => (cmp(x, y) <= 0 ? x : y))),
  MAX: (a) => FN.GREATEST(a), MIN: (a) => FN.LEAST(a),
};
Object.assign(FN, { UCASE: FN.UPPER, LCASE: FN.LOWER, CHAR_LENGTH: FN.LENGTH, SUBSTRING: FN.SUBSTR, CEILING: FN.CEIL, POW: FN.POWER, IFNULL: FN.COALESCE, IF: FN.IIF, LOG: FN.LN });

/* ---------------- expression evaluation ---------------- */
function lookup(n, env, ctx) {
  const key = n.n.toLowerCase();
  for (let e = env; e; e = e.parent) {
    if (n.t) { const r = e.t[n.t]; if (r && key in r) return r[key]; }
    else for (const a in e.t) { const r = e.t[a]; if (r && key in r) return r[key]; }
    if (!n.t && e.sel && e.sel[key]) return ctx.f(e.sel[key], e);
    if (e.empty) return null;
  }
  fail("Unknown column '" + (n.t ? n.t + '.' : '') + n.n + "'");
}
function agg(n, env, ctx) {
  if (!env.group) fail('Invalid use of aggregate function ' + n.name);
  if (n.star) return env.group.length;
  let vals = env.group.map((g) => ev(n.args[0], g, ctx)).filter((v) => v != null);
  if (n.distinct) { const seen = new Set(); vals = vals.filter((v) => { const k = typeof v + v; if (seen.has(k)) return false; seen.add(k); return true; }); }
  switch (n.name) {
    case 'COUNT': return vals.length;
    case 'SUM': return vals.length ? vals.reduce((a, b) => a + num(b), 0) : null;
    case 'TOTAL': return vals.reduce((a, b) => a + num(b), 0);
    case 'AVG': return vals.length ? vals.reduce((a, b) => a + num(b), 0) / vals.length : null;
    case 'MIN': return vals.length ? vals.reduce((a, b) => (cmp(a, b) <= 0 ? a : b)) : null;
    case 'MAX': return vals.length ? vals.reduce((a, b) => (cmp(a, b) >= 0 ? a : b)) : null;
    default: { if (!vals.length) return null; const sep = n.sep != null ? n.sep : n.args[1] ? ev(n.args[1], EMPTY, ctx) : ','; return vals.join(sep); }
  }
}
function ev(n, env, ctx) {
  if (!ctx.f) ctx.f = ev0(ctx);
  return ctx.f(n, env);
}
function ev0(ctx) {
  const f = (n, env) => {
    switch (n.k) {
      case 'lit': return n.v;
      case 'default': return undefined;
      case 'col': return lookup(n, env, ctx);
      case 'un': { const v = f(n.e, env); if (n.op === 'NOT') return v == null ? null : truthy(v) ? 0 : 1; return v == null ? null : n.op === '-' ? -v : v; }
      case 'bin': return binop(n, env, f);
      case 'isnull': return (f(n.e, env) == null) !== n.not ? 1 : 0;
      case 'between': { const v = f(n.e, env), a = f(n.a, env), b = f(n.b, env); if (v == null || a == null || b == null) return null; const r = cmp(v, a) >= 0 && cmp(v, b) <= 0; return r !== n.not ? 1 : 0; }
      case 'like': { const v = f(n.e, env), p = f(n.p, env); if (v == null || p == null) return null; return likeRe(p).test(String(v)) !== n.not ? 1 : 0; }
      case 'regexp': { const v = f(n.e, env), p = f(n.p, env); if (v == null || p == null) return null; return new RegExp(p, 'i').test(String(v)) !== n.not ? 1 : 0; }
      case 'in': {
        const v = f(n.e, env); if (v == null) return null;
        const vals = n.q ? runQuery(n.q, ctx, env).rows.map((r) => r[0]) : n.list.map((x) => f(x, env));
        if (vals.some((x) => x != null && cmp(x, v) === 0)) return n.not ? 0 : 1;
        return vals.some((x) => x == null) ? null : n.not ? 1 : 0;
      }
      case 'exists': return runQuery(n.q, ctx, env).rows.length ? 1 : 0;
      case 'sub': { const r = runQuery(n.q, ctx, env); return r.rows.length ? r.rows[0][0] : null; }
      case 'case': {
        const b = n.base ? f(n.base, env) : null;
        for (const [w, t] of n.whens) { if (n.base ? b != null && cmp(b, f(w, env)) === 0 : truthy(f(w, env))) return f(t, env); }
        return n.els ? f(n.els, env) : null;
      }
      case 'cast': {
        const v = f(n.e, env); if (v == null) return null; const t = n.ty.toUpperCase();
        if (/INT|SIGNED/.test(t)) { const x = parseInt(v); return isNaN(x) ? 0 : x; }
        if (/REAL|FLOA|DOUB|DEC|NUM/.test(t)) { const x = parseFloat(v); return isNaN(x) ? 0 : x; }
        if (/CHAR|TEXT/.test(t)) return String(v); return v;
      }
      case 'fn': {
        if (isAggNode(n)) return agg(n, env, ctx);
        if (n.name === 'VALUES' && env.nr) return env.nr[n.args[0].n.toLowerCase()];
        const fn = FN[n.name]; if (!fn) fail('Unknown function ' + n.name + '()');
        return fn(n.args.map((a) => f(a, env)));
      }
    }
    fail('Cannot evaluate expression');
  };
  return f;
}
function binop(n, env, f) {
  const op = n.op;
  if (op === 'AND') { const l = f(n.l, env); if (l != null && !truthy(l)) return 0; const r = f(n.r, env); if (r != null && !truthy(r)) return 0; return l == null || r == null ? null : 1; }
  if (op === 'OR') { const l = f(n.l, env); if (l != null && truthy(l)) return 1; const r = f(n.r, env); if (r != null && truthy(r)) return 1; return l == null || r == null ? null : 0; }
  const l = f(n.l, env), r = f(n.r, env);
  if (op === 'IS' || op === 'ISNOT') { const eq = (l == null && r == null) || (l != null && r != null && cmp(l, r) === 0); return (op === 'IS') === eq ? 1 : 0; }
  if (l == null || r == null) return null;
  switch (op) {
    case '=': case '==': return cmp(l, r) === 0 ? 1 : 0;
    case '<>': case '!=': return cmp(l, r) !== 0 ? 1 : 0;
    case '<': return cmp(l, r) < 0 ? 1 : 0; case '>': return cmp(l, r) > 0 ? 1 : 0;
    case '<=': return cmp(l, r) <= 0 ? 1 : 0; case '>=': return cmp(l, r) >= 0 ? 1 : 0;
    case '+': return num(l) + num(r); case '-': return num(l) - num(r); case '*': return num(l) * num(r);
    case '/': return num(r) === 0 ? null : num(l) / num(r);
    case '%': return num(r) === 0 ? null : num(l) % num(r);
    case '||': return String(l) + String(r);
  }
}

/* ---------------- SELECT execution ---------------- */
const mk = (r, cols) => { const names = cols || r.names; const cs = names.map((n) => ({ name: n, key: n.toLowerCase() })); return { cols: cs, rows: r.rows.map((a) => { const o = {}; cs.forEach((c, i) => { o[c.key] = a[i]; }); return o; }) }; };
function srcRows(s, ctx, parent) {
  if (s.kind === 'sub') return { alias: s.alias.toLowerCase(), ...mk(runQuery(s.q, ctx, parent)) };
  const n = s.name.toLowerCase(), alias = (s.alias || s.name).toLowerCase();
  if (ctx.ctes[n]) return { alias, ...ctx.ctes[n] };
  if (ctx.db.views[n]) return { alias, ...mk(runQuery(new Parser(ctx.db.views[n].sql).query(), ctx, null)) };
  const t = getTable(ctx, s.name); return { alias, cols: t.cols, rows: t.rows };
}
function buildFrom(f, ctx, parent) {
  const L = srcRows(f.first, ctx, parent);
  let meta = [{ alias: L.alias, cols: L.cols }];
  let envs = L.rows.map((r) => ({ t: { [L.alias]: r }, m: meta, parent }));
  for (const j of f.joins) {
    const R = srcRows(j.src, ctx, parent);
    const nm = [...meta, { alias: R.alias, cols: R.cols }];
    const nullR = Object.fromEntries(R.cols.map((c) => [c.key, null]));
    const out = [], hit = new Set();
    const test = (e) => {
      if (j.on) return truthy(ev(j.on, e, ctx));
      if (j.using) return j.using.every((k) => { let lv; for (const a of meta) { const row = e.t[a.alias]; if (row && k in row) { lv = row[k]; break; } } const rv = e.t[R.alias][k]; return lv != null && rv != null && cmp(lv, rv) === 0; });
      return true;
    };
    for (const le of envs) {
      let m = false;
      R.rows.forEach((r, ri) => { const ne = { t: { ...le.t, [R.alias]: r }, m: nm, parent }; if (test(ne)) { out.push(ne); m = true; hit.add(ri); } });
      if (!m && (j.type === 'LEFT' || j.type === 'FULL')) out.push({ t: { ...le.t, [R.alias]: nullR }, m: nm, parent });
      if (out.length > 300000) fail('Join result too large (limit 300000 rows)');
    }
    if (j.type === 'RIGHT' || j.type === 'FULL') {
      const nullL = Object.fromEntries(meta.map((a) => [a.alias, Object.fromEntries(a.cols.map((c) => [c.key, null]))]));
      R.rows.forEach((r, ri) => { if (!hit.has(ri)) out.push({ t: { ...nullL, [R.alias]: r }, m: nm, parent }); });
    }
    envs = out; meta = nm;
  }
  return { envs, meta };
}
function sortRows(rows, keyOf, order) {
  rows.forEach((r) => { r.k = keyOf(r); });
  rows.sort((a, b) => {
    for (let i = 0; i < order.length; i++) {
      const x = a.k[i], y = b.k[i], o = order[i]; let c;
      if (x == null || y == null) { if (x == null && y == null) continue; const nf = o.nf ? o.nf === 'f' : !o.d; c = x == null ? (nf ? -1 : 1) : (nf ? 1 : -1); }
      else { c = cmp(x, y); if (o.d) c = -c; }
      if (c) return c;
    }
    return 0;
  });
}
function runCore(c, ctx, parent, q) {
  let envs, meta = [];
  if (c.from) { const b = buildFrom(c.from, ctx, parent); envs = b.envs; meta = b.meta; } else envs = [{ t: {}, m: [], parent }];
  const sel = {}; for (const it of c.items) if (it.alias) sel[it.alias.toLowerCase()] = it.expr;
  for (const e of envs) e.sel = sel;
  if (c.where) envs = envs.filter((e) => truthy(ev(c.where, e, ctx)));
  const order = q && q.order;
  const hasAgg = c.items.some((i) => i.expr && isAgg(i.expr)) || isAgg(c.having) || (order && order.some((o) => isAgg(o.e)));
  let units = envs;
  if (c.group || hasAgg) {
    const groups = new Map();
    if (c.group) {
      const gx = c.group.map((g) => (g.k === 'lit' && typeof g.v === 'number' && c.items[g.v - 1] && c.items[g.v - 1].expr) || g);
      for (const e of envs) { const k = JSON.stringify(gx.map((g) => ev(g, e, ctx))); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(e); }
    } else groups.set('', envs);
    units = []; for (const rows of groups.values()) units.push(Object.assign({}, rows[0] || { t: {}, m: meta, parent, empty: true }, { group: rows, sel }));
    if (c.having) units = units.filter((u) => truthy(ev(c.having, u, ctx)));
  }
  const names = [], spec = [];
  for (const it of c.items) {
    if (it.star) { if (!c.from) fail('No tables used'); for (const m of meta) if (!it.t || m.alias === it.t) for (const col of m.cols) { names.push(col.name); spec.push({ a: m.alias, k: col.key }); } }
    else { names.push(it.alias || it.label); spec.push({ e: it.expr }); }
  }
  const proj = (u) => spec.map((s) => (s.e ? ev(s.e, u, ctx) : u.t[s.a] ? u.t[s.a][s.k] : null));
  let rows = units.map((u) => ({ u, o: proj(u) }));
  if (c.distinct) { const seen = new Set(); rows = rows.filter((r) => { const k = JSON.stringify(r.o); if (seen.has(k)) return false; seen.add(k); return true; }); }
  if (order) sortRows(rows, (r) => order.map((o) => (o.e.k === 'lit' && typeof o.e.v === 'number' ? r.o[o.e.v - 1] : ev(o.e, r.u, ctx))), order);
  let out = rows.map((r) => r.o);
  if (q) out = limitRows(out, q, ctx);
  return { names, rows: out };
}
function limitRows(rows, q, ctx) {
  const off = q.offset != null ? Number(ev(q.offset, EMPTY, ctx)) : 0, lim = q.limit != null ? Number(ev(q.limit, EMPTY, ctx)) : Infinity;
  return q.offset != null || q.limit != null ? rows.slice(off, lim < 0 ? undefined : off + lim) : rows;
}
const sameRow = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function setop(op, a, b) {
  if (op === 'UNION ALL') return a.concat(b);
  const uniq = (r) => { const s = new Set(); return r.filter((x) => { const k = JSON.stringify(x); if (s.has(k)) return false; s.add(k); return true; }); };
  if (op === 'UNION') return uniq(a.concat(b));
  const kb = new Set(b.map((x) => JSON.stringify(x)));
  return uniq(a).filter((x) => kb.has(JSON.stringify(x)) === (op === 'INTERSECT'));
}
function defineCte(c, ctx, parent) {
  const name = c.name.toLowerCase(), q = c.q;
  const rec = q.parts.length > 1 && /^UNION/.test(q.ops[0]) && JSON.stringify(q.parts.slice(1)).toLowerCase().includes('"name":"' + name + '"');
  if (!rec) { ctx.ctes[name] = mk(runQuery(q, ctx, parent), c.cols); return; }
  const anchor = runCore(q.parts[0], ctx, parent, null), names = c.cols || anchor.names;
  let all = anchor.rows.slice(), delta = anchor.rows;
  for (let it = 0; it < 1000 && delta.length; it++) {
    ctx.ctes[name] = mk({ names, rows: delta });
    let nxt = []; for (let k = 1; k < q.parts.length; k++) nxt = nxt.concat(runCore(q.parts[k], ctx, parent, null).rows);
    if (q.ops[0] === 'UNION') nxt = nxt.filter((r) => !all.some((a) => sameRow(a, r)));
    all = all.concat(nxt); delta = nxt;
  }
  ctx.ctes[name] = mk({ names, rows: all });
}
function runQuery(q, ctx, parent) {
  const saved = ctx.ctes;
  if (q.ctes.length) { ctx.ctes = Object.assign({}, saved); for (const c of q.ctes) defineCte(c, ctx, parent); }
  try {
    const single = q.parts.length === 1;
    const res = q.parts.map((p) => runCore(p, ctx, parent, single ? q : null));
    let rows = res[0].rows; const names = res[0].names;
    if (!single) {
      for (let i = 1; i < res.length; i++) rows = setop(q.ops[i - 1], rows, res[i].rows);
      if (q.order) {
        const idx = q.order.map((o) => { if (o.e.k === 'lit' && typeof o.e.v === 'number') return o.e.v - 1; const i = o.e.k === 'col' ? names.findIndex((x) => x.toLowerCase() === o.e.n.toLowerCase()) : -1; if (i < 0) fail('ORDER BY on a UNION must use an output column name or position'); return i; });
        const wrap = rows.map((o) => ({ o })); sortRows(wrap, (r) => idx.map((i) => r.o[i]), q.order); rows = wrap.map((r) => r.o);
      }
      rows = limitRows(rows, q, ctx);
    }
    return { names, rows };
  } finally { ctx.ctes = saved; }
}

/* ---------------- DML / DDL ---------------- */
const newDB = () => ({ tables: {}, views: {}, indexes: {} });
function getTable(ctx, name) { const t = ctx.db.tables[name.toLowerCase()]; if (!t) fail("Table '" + name + "' doesn't exist"); return t; }
function colOf(t, name) { const c = t.cols.find((x) => x.key === name.toLowerCase()); if (!c) fail("Unknown column '" + name + "' in '" + t.name + "'"); return c; }
const tenv = (t, row) => ({ t: { [t.name.toLowerCase()]: row }, m: [{ alias: t.name.toLowerCase(), cols: t.cols }] });
function validate(t, row, ctx) {
  for (const c of t.cols) {
    if ((c.notnull || t.pk.includes(c.key)) && row[c.key] == null) fail("Column '" + c.name + "' cannot be null");
    if (c.check) { const r = ev(c.check, tenv(t, row), ctx); if (r != null && !truthy(r)) fail("CHECK constraint failed for column '" + c.name + "'"); }
  }
  for (const ck of t.checks || []) { const r = ev(ck, tenv(t, row), ctx); if (r != null && !truthy(r)) fail('CHECK constraint failed'); }
}
function findConflict(t, row, skip) {
  const sets = []; if (t.pk.length) sets.push({ keys: t.pk, name: 'PRIMARY' }); for (const u of t.uniques) sets.push({ keys: u.keys, name: u.name || u.keys.join('_') });
  for (const s of sets) {
    if (s.keys.some((k) => row[k] == null)) continue;
    const i = t.rows.findIndex((r, ix) => ix !== skip && s.keys.every((k) => cmp(r[k], row[k]) === 0));
    if (i >= 0) return { i, name: s.name, val: s.keys.map((k) => row[k]).join('-') };
  }
  return null;
}
function doInsert(st, ctx) {
  const t = getTable(ctx, st.t), tn = t.name.toLowerCase();
  const cols = st.cols ? st.cols.map((n) => colOf(t, n)) : t.cols;
  const vrows = st.q ? runQuery(st.q, ctx, null).rows : st.values.map((r) => r.map((e) => (e.k === 'default' ? undefined : ev(e, tenv(t, {}), ctx))));
  const backup = t.rows.slice(), ai = t.ai; let n = 0, last = null;
  try {
    for (const vr of vrows) {
      if (vr.length !== cols.length) fail("Column count doesn't match value count");
      const given = {}; cols.forEach((c, i) => { given[c.key] = vr[i]; });
      const row = {};
      for (const c of t.cols) {
        let v = given[c.key]; if (v === undefined) v = c.def ? ev(c.def, EMPTY, ctx) : null;
        if (c.auto && (v == null || v === 0)) v = ++t.ai; else if (c.auto && typeof v === 'number' && v > t.ai) t.ai = v;
        row[c.key] = coerce(v, c.type);
      }
      let dup = findConflict(t, row, null);
      if (dup && st.upd) {
        const ex = t.rows[dup.i], env = { t: { [tn]: ex, excluded: row }, m: [], nr: row }, nr = { ...ex };
        for (const [c, e] of st.upd) { const col = colOf(t, c); nr[col.key] = coerce(ev(e, env, ctx), col.type); }
        validate(t, nr, ctx); t.rows[dup.i] = nr; n += 2; continue;
      }
      if (dup && st.ignore) continue;
      while (dup && st.replace) { t.rows.splice(dup.i, 1); dup = findConflict(t, row, null); }
      if (dup) fail("Duplicate entry '" + dup.val + "' for key '" + dup.name + "'");
      validate(t, row, ctx); t.rows.push(row); n++; last = t.pk.length === 1 ? row[t.pk[0]] : null;
    }
  } catch (e) { t.rows = backup; t.ai = ai; throw e; }
  return { type: 'ok', affected: n, insertId: last, message: 'Query OK, ' + n + ' row(s) affected' };
}
function doUpdate(st, ctx) {
  const t = getTable(ctx, st.t), upd = [];
  t.rows.forEach((row, i) => {
    const env = tenv(t, row); if (st.where && !truthy(ev(st.where, env, ctx))) return;
    const nr = { ...row }; for (const [c, e] of st.sets) { const col = colOf(t, c); nr[col.key] = coerce(ev(e, env, ctx), col.type); } upd.push([i, nr]);
  });
  const backup = t.rows.slice();
  try {
    for (const [i, nr] of upd) { validate(t, nr, ctx); t.rows[i] = nr; }
    for (const [i] of upd) { const d = findConflict(t, t.rows[i], i); if (d) fail("Duplicate entry '" + d.val + "' for key '" + d.name + "'"); }
  } catch (e) { t.rows = backup; throw e; }
  return { type: 'ok', affected: upd.length, message: 'Query OK, ' + upd.length + ' row(s) affected' };
}
function doCreate(st, ctx) {
  const key = st.name.toLowerCase();
  if (ctx.db.tables[key] || ctx.db.views[key]) { if (st.ine) return { type: 'ok', message: 'Table already exists (skipped)' }; fail("Table '" + st.name + "' already exists"); }
  const cols = st.cols.map((c) => ({ ...c })); const pk = [...st.pk]; const uniques = [...st.uniques];
  for (const c of cols) { if (c.pk && !pk.includes(c.key)) pk.push(c.key); if (c.unique) uniques.push({ keys: [c.key] }); }
  for (const k of pk) { const c = cols.find((x) => x.key === k); if (!c) fail("Unknown column '" + k + "' in key list"); c.notnull = true; }
  for (const c of cols) if (pk.length === 1 && pk[0] === c.key && /INT/i.test(c.type)) c.auto = true;
  if (new Set(cols.map((c) => c.key)).size !== cols.length) fail('Duplicate column name');
  ctx.db.tables[key] = { name: st.name, cols, pk, uniques, checks: st.checks, rows: [], ai: 0 };
  return { type: 'ok', message: "Table '" + st.name + "' created" };
}
function doAlter(st, ctx) {
  const t = getTable(ctx, st.t);
  if (st.a === 'add') {
    const c = { ...st.col }; if (t.cols.some((x) => x.key === c.key)) fail('Duplicate column name');
    t.cols.push(c); for (const r of t.rows) r[c.key] = c.auto ? ++t.ai : c.def ? ev(c.def, EMPTY, ctx) : null;
    if (c.unique) t.uniques.push({ keys: [c.key] });
  } else if (st.a === 'drop') {
    const c = colOf(t, st.name); t.cols = t.cols.filter((x) => x !== c); for (const r of t.rows) delete r[c.key];
    t.pk = t.pk.filter((k) => k !== c.key); t.uniques = t.uniques.filter((u) => !u.keys.includes(c.key));
  } else if (st.a === 'rencol') {
    const c = colOf(t, st.from), nk = st.to.toLowerCase(); if (t.cols.some((x) => x.key === nk)) fail('Duplicate column name');
    for (const r of t.rows) { r[nk] = r[c.key]; delete r[c.key]; }
    t.pk = t.pk.map((k) => (k === c.key ? nk : k)); t.uniques.forEach((u) => { u.keys = u.keys.map((k) => (k === c.key ? nk : k)); });
    c.name = st.to; c.key = nk;
    t.rows = t.rows.map((r) => { const o = {}; for (const x of t.cols) o[x.key] = r[x.key]; return o; });
  } else {
    const nk = st.to.toLowerCase(); if (ctx.db.tables[nk]) fail("Table '" + st.to + "' already exists");
    delete ctx.db.tables[st.t.toLowerCase()]; t.name = st.to; ctx.db.tables[nk] = t;
  }
  return { type: 'ok', message: 'Table altered' };
}
function execStmt(st, ctx) {
  const db = ctx.db;
  switch (st.s) {
    case 'select': { const r = runQuery(st.q, ctx, null); return { type: 'rows', columns: r.names, rows: r.rows }; }
    case 'insert': return doInsert(st, ctx);
    case 'update': return doUpdate(st, ctx);
    case 'delete': { const t = getTable(ctx, st.t); const before = t.rows.length; t.rows = st.where ? t.rows.filter((r) => !truthy(ev(st.where, tenv(t, r), ctx))) : []; const n = before - t.rows.length; return { type: 'ok', affected: n, message: 'Query OK, ' + n + ' row(s) affected' }; }
    case 'create': return doCreate(st, ctx);
    case 'ctas': {
      const key = st.name.toLowerCase(); if (db.tables[key]) { if (st.ine) return { type: 'ok', message: 'Table already exists (skipped)' }; fail("Table '" + st.name + "' already exists"); }
      const r = runQuery(st.q, ctx, null); const cols = r.names.map((n) => ({ name: n, key: n.toLowerCase(), type: '' }));
      db.tables[key] = { name: st.name, cols, pk: [], uniques: [], checks: [], ai: 0, rows: r.rows.map((a) => Object.fromEntries(cols.map((c, i) => [c.key, a[i]]))) };
      return { type: 'ok', affected: r.rows.length, message: 'Table created with ' + r.rows.length + ' row(s)' };
    }
    case 'drop': for (const n of st.names) { if (!db.tables[n.toLowerCase()]) { if (st.ie) continue; fail("Unknown table '" + n + "'"); } delete db.tables[n.toLowerCase()]; for (const k in db.indexes) if (db.indexes[k].t.toLowerCase() === n.toLowerCase()) delete db.indexes[k]; } return { type: 'ok', message: 'Table dropped' };
    case 'dropview': for (const n of st.names) { if (!db.views[n.toLowerCase()]) { if (st.ie) continue; fail("Unknown view '" + n + "'"); } delete db.views[n.toLowerCase()]; } return { type: 'ok', message: 'View dropped' };
    case 'truncate': { const t = getTable(ctx, st.t); t.rows = []; t.ai = 0; return { type: 'ok', message: 'Table truncated' }; }
    case 'alter': return doAlter(st, ctx);
    case 'view': { const k = st.name.toLowerCase(); if (db.views[k] || db.tables[k]) { if (st.ine) return { type: 'ok', message: 'View exists (skipped)' }; fail("'" + st.name + "' already exists"); } db.views[k] = { sql: st.sql }; return { type: 'ok', message: 'View created' }; }
    case 'index': {
      const t = getTable(ctx, st.t), k = st.name.toLowerCase(); if (db.indexes[k]) { if (st.ine) return { type: 'ok', message: 'Index exists (skipped)' }; fail("Index '" + st.name + "' already exists"); }
      st.cols.forEach((c) => colOf(t, c));
      if (st.uniq) { const seen = new Set(); for (const r of t.rows) { const v = st.cols.map((c) => r[c]); if (v.some((x) => x == null)) continue; const s = JSON.stringify(v); if (seen.has(s)) fail('Cannot create unique index: duplicate values exist'); seen.add(s); } t.uniques.push({ keys: st.cols, name: st.name, idx: k }); }
      db.indexes[k] = { name: st.name, t: t.name, cols: st.cols, uniq: !!st.uniq }; return { type: 'ok', message: 'Index created' };
    }
    case 'dropindex': { const k = st.name.toLowerCase(); const ix = db.indexes[k]; if (!ix) { if (st.ie) return { type: 'ok', message: 'OK' }; fail("Unknown index '" + st.name + "'"); } const t = db.tables[ix.t.toLowerCase()]; if (t) t.uniques = t.uniques.filter((u) => u.idx !== k); delete db.indexes[k]; return { type: 'ok', message: 'Index dropped' }; }
    case 'show': return { type: 'rows', columns: ['Tables'], rows: [...Object.values(db.tables).map((t) => [t.name]), ...Object.keys(db.views).map((v) => [v])] };
    case 'describe': {
      const t = getTable(ctx, st.t);
      if (st.pragma) return { type: 'rows', columns: ['cid', 'name', 'type', 'notnull', 'dflt_value', 'pk'], rows: t.cols.map((c, i) => [i, c.name, c.type, c.notnull || t.pk.includes(c.key) ? 1 : 0, c.defText || null, t.pk.includes(c.key) ? t.pk.indexOf(c.key) + 1 : 0]) };
      return { type: 'rows', columns: ['Field', 'Type', 'Null', 'Key', 'Default', 'Extra'], rows: t.cols.map((c) => [c.name, c.type, c.notnull || t.pk.includes(c.key) ? 'NO' : 'YES', t.pk.includes(c.key) ? 'PRI' : t.uniques.some((u) => u.keys.includes(c.key)) ? 'UNI' : '', c.defText || null, c.auto ? 'auto_increment' : '']) };
    }
    case 'begin': ctx.snap = JSON.stringify(db); return { type: 'ok', message: 'Transaction started' };
    case 'commit': ctx.snap = null; return { type: 'ok', message: 'Committed' };
    case 'rollback': { if (ctx.snap) { const s = JSON.parse(ctx.snap); db.tables = s.tables; db.views = s.views; db.indexes = s.indexes; ctx.snap = null; } return { type: 'ok', message: 'Rolled back' }; }
    case 'noop': return { type: 'ok', message: st.msg };
  }
  fail('Unsupported statement');
}

/** Run a SQL script against a db object (mutated in place). Never throws. */
function run(db, sql) {
  const t0 = Date.now(), results = []; let changed = false, error = null;
  try {
    const stmts = new Parser(sql).script(); const ctx = { db, ctes: {}, snap: null };
    for (const [i, st] of stmts.entries()) {
      try { const r = execStmt(st, ctx); if (st.s !== 'select' && st.s !== 'show' && st.s !== 'describe') changed = true; results.push(r); }
      catch (e) { if (!(e instanceof SQLError)) e = new SQLError('Internal error: ' + e.message); error = (stmts.length > 1 ? 'Statement ' + (i + 1) + ': ' : '') + e.message; break; }
    }
  } catch (e) { error = e instanceof SQLError ? e.message : 'Internal error: ' + e.message; }
  return { results, changed, error, ms: Date.now() - t0 };
}
function schemaOf(db) {
  return {
    tables: Object.values(db.tables).map((t) => ({ name: t.name, rows: t.rows.length, columns: t.cols.map((c) => ({ name: c.name, type: c.type, pk: t.pk.includes(c.key), notnull: !!c.notnull, auto: !!c.auto, default: c.defText || null })) })),
    views: Object.keys(db.views),
  };
}
/** 'read' if every statement only reads data, otherwise 'write'. Throws on syntax errors. */
function classifyStatements(sql) {
  const st = new Parser(sql).script();
  return st.length && st.every((x) => x.s === 'select' || x.s === 'show' || x.s === 'describe') ? 'read' : 'write';
}
/** lower-case identifiers used in a script (to decide which tables must be loaded) */
function identifiersIn(sql) { return tokenize(sql).filter((t) => t.t === 'id').map((t) => t.v.toLowerCase()); }
export { run, newDB, schemaOf, SQLError, classifyStatements, identifiersIn };
