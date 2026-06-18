#!/usr/bin/env node
/**
 * 쿼크화(Quarkify) v1.0.0 — Generic config-driven engine (Quarkify v1.0.0 — Generic config-driven engine)
 *
 * Copyright 2026 teamjupiter
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 *
 * v3.1 의 모든 분해 로직을 보존하면서, 프로젝트별 정보(SRC_DIR / OUTPUT_DIR /
 * SOURCE_FILES / PERF_DATA / role classifier)를 외부 config 파일로 분리. (Preserving all decomposition logic from v3.1, while separating project-specific information (SRC_DIR / OUTPUT_DIR / SOURCE_FILES / PERF_DATA / role classifier) into external config files.)
 *
 * 사용법 (Usage):
 *   node quarkify_v7.mjs configs/sovereign_cuda.mjs
 *   node quarkify_v7.mjs configs/sovereign_metal.mjs
 *   node quarkify_v7.mjs configs/llama_cpp_cuda.mjs
 *
 * Config 인터페이스 (Config Interface) (configs/*.mjs):
 *   export default {
 *     name:         'sovereign-cuda-llama3',
 *     srcDir:       '/abs/path/to/source/root',
 *     outDir:       '/abs/path/to/quark/output',
 *     sourceFiles:  ['rel/path/file.ext', ...],
 *     perfData:     { 'kernel_name': { dram_pct: 73.9, sm_pct: 86.9, ... } },
 *     guessRole:    (name: string) => string,   // project-specific role map
 *   };
 *
 * v3.1 대비 v4 변경점 (Changes in v4 compared to v3.1):
 *   1. SRC_DIR / OUTPUT_DIR / SOURCE_FILES / PERF_DATA / guessRole 모두 config 로 이동 (All moved to config)
 *   2. Metal `.metal` (MSL) 파서 강화 (Enhanced Metal .metal (MSL) parser) — kernel void / device / threadgroup /
 *      constant storage qualifier 인식 (recognizing qualifiers), [[buffer(N)]] attribute 추출 (extracting attributes),
 *      함수 본문 재귀 파싱 (recursive parsing of function body) (Zig fn parser 와 동일 트릭 - same trick as Zig fn parser)
 *   3. Objective-C `.m` / `.mm` 기본 파싱 (Basic parsing of Objective-C .m / .mm) (interface / implementation / @-decl)
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import { execSync } from 'child_process';
import crypto from 'crypto';
import { Worker, isMainThread, workerData, parentPort } from 'worker_threads';

// ─── CLI / 컨피그 로드 (Load CLI / Config) ───
// 역방향 서브커맨드(--collapse / --expand)는 config 없이 동작한다.
// (Reverse subcommands (--collapse / --expand) run without a config.)
const REVERSE_MODE = isMainThread && (process.argv[2] === '--collapse' || process.argv[2] === '--expand');
// 문서 서브커맨드(--doc / --doc-join)도 config 없이, 파일 경로만 받아 동작한다.
// (Document subcommands also run config-less, taking a file path directly.)
const DOC_MODE = isMainThread && (process.argv[2] === '--doc' || process.argv[2] === '--doc-join');
// 분석 서브커맨드(--stats / --diff)도 config 없이 기존 출력 디렉터리만 받아 동작한다.
const STATS_MODE = isMainThread && process.argv[2] === '--stats';
const DIFF_MODE = isMainThread && process.argv[2] === '--diff';
// OSS 난제 해결 도구: 기존 출력 + 이슈 키워드로 "해결 컨텍스트 팩" 생성 (config 불필요).
const SOLVE_MODE = isMainThread && process.argv[2] === '--solve';
// 데드코드 감지: 콜그래프에서 들어오는 엣지(호출자)가 없는 심볼 = 끊긴 선 = 데드코드 후보.
const DEAD_MODE = isMainThread && process.argv[2] === '--dead';
// --k6 는 config 가 필요하다 (srcDir/sourceFiles 재사용). config 경로는 argv[3].
// (--k6 needs a config; its path is argv[3].)
const K6_MODE = isMainThread && process.argv[2] === '--k6';

// 메인 스레드는 argv 에서, 워커 스레드는 workerData 에서 config 경로를 받는다.
// (Main thread reads config path from argv; worker threads receive it via workerData.)
const configPath = isMainThread ? (K6_MODE ? process.argv[3] : process.argv[2]) : workerData.configPath;
let CONFIG = {};
let cfgAbs = null;

if (!REVERSE_MODE && !DOC_MODE && !STATS_MODE && !DIFF_MODE && !SOLVE_MODE && !DEAD_MODE) {
  if (!configPath) {
    console.error('❌ 에러: 설정 파일 경로가 제공되지 않았습니다.');
    console.error('사용법: node quarkify.mjs <configs/config_name.mjs>');
    console.error('       node quarkify.mjs --collapse <outDir> [outFile]');
    console.error('       node quarkify.mjs --expand <tree.json> <targetDir>');
    process.exit(1);
  }
  if (!fs.existsSync(configPath)) {
    console.error(`❌ 에러: 지정한 설정 파일을 찾을 수 없습니다: "${configPath}"`);
    process.exit(1);
  }
  cfgAbs = path.resolve(configPath);
  if (!fs.existsSync(cfgAbs)) {
    console.error(`Config not found: ${cfgAbs}`);
    process.exit(1);
  }

  try {
    const imported = await import(pathToFileURL(cfgAbs).href);
    if (!imported || !imported.default) {
      console.error(`❌ 에러: 설정 파일에 'default export'가 정의되어 있지 않습니다: "${configPath}"`);
      process.exit(1);
    }
    CONFIG = imported.default;
  } catch (err) {
    console.error(`❌ 에러: 설정 파일을 불러오는 중 오류가 발생했습니다:`, err.message);
    process.exit(1);
  }

  // 필수 속성 검증 (Required Property Validation)
  const requiredFields = ['srcDir', 'outDir', 'sourceFiles'];
  for (const field of requiredFields) {
    if (CONFIG[field] === undefined || CONFIG[field] === null) {
      console.error(`❌ 에러: 설정 파일에 필수 속성 '${field}'이(가) 누락되었습니다.`);
      process.exit(1);
    }
  }
}

// ─── 유틸 (Utils) ───
function safeName(name) {
  if (!name) return '_anonymous_';
  return name.replace(/[^a-zA-Z0-9_$.]/g, '_').substring(0, 100);
}
function mkdirSync(d) { fs.mkdirSync(d, { recursive: true }); }
function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }
function perfBand(pct) {
  if (pct < 1)   return 'lt_01';
  if (pct < 10)  return '01_10';
  if (pct < 30)  return '10_30';
  if (pct < 50)  return '30_50';
  if (pct < 70)  return '50_70';
  if (pct < 85)  return '70_85';
  if (pct < 95)  return '85_95';
  return '95_max';
}

const guessRole = CONFIG.guessRole || ((_) => 'general');
const OUTPUT_MARKER = '.quarkify-output';

// Python 인터프리터 버전을 프로세스당 1회만 조회해 캐시 (이전: .py 파일마다 execSync 호출 → 느림).
// (Query the Python interpreter version once per process and cache it — previously execSync ran per .py file.)
let __pyVersionClean;
function getPythonVersionClean() {
  if (__pyVersionClean !== undefined) return __pyVersionClean;
  let pyVer = 'unknown';
  try {
    pyVer = execSync('python3 --version', { encoding: 'utf8' }).trim();
  } catch {
    try {
      pyVer = execSync('python --version', { encoding: 'utf8' }).trim();
    } catch {}
  }
  __pyVersionClean = pyVer.replace(/[^0-9.]/g, '').replace(/\./g, '_');
  return __pyVersionClean;
}

// ─── PTX arg 의미 분류 (PTX Argument Classification) ───
function classifyPtxArg(raw, opcode) {
  let r = raw.trim();
  if (!r) return { kind: 'empty', value: '', type: '' };
  if (r.startsWith('@')) return { kind: 'pred', value: r.substring(1), type: '' };
  if (r.startsWith('%')) return { kind: 'reg', value: r.substring(1), type: '' };
  if (r.startsWith('addr_')) return { kind: 'addr', value: r.substring(5), type: '' };
  if (/^0[fd][0-9A-Fa-f]+$/.test(r)) return { kind: 'imm', value: r, type: r[1] === 'f' ? 'f32' : 'f64' };
  if (/^0[xX][0-9A-Fa-f]+$/.test(r)) return { kind: 'imm', value: r, type: 'hex' };
  if (/^-?\d+$/.test(r)) return { kind: 'imm', value: r, type: 'i32' };
  if (/^[A-Z_][A-Z0-9_]*$/.test(r) || (opcode === 'bra' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(r))) {
    return { kind: 'label', value: r, type: '' };
  }
  return { kind: 'other', value: r, type: '' };
}

// ─── Zig struct 필드 파서 (Zig Struct Field Parser) ───
function parseZigStructFields(body) {
  const fields = [];
  const lines = body.split('\n');
  for (const raw of lines) {
    let l = raw.replace(/\/\/.*/g, '').trim();
    if (!l || l.startsWith('pub ') || l.startsWith('fn ') ||
        l.startsWith('const ') || l.startsWith('var ')) continue;
    const m = l.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*([^,;=]+)(?:=\s*([^,;]+))?[,;]?\s*$/);
    if (!m) continue;
    fields.push({ name: m[1].trim(), type: (m[2] || '').trim(), default: (m[3] || '').trim() });
  }
  return fields;
}

// ─── Java class/interface 필드 파서 (Java Class/Interface Field Parser) ───
function parseJavaFields(body) {
  const fields = [];
  const lines = body.split('\n');
  for (const raw of lines) {
    let l = raw.replace(/\/\/.*/g, '').trim();
    if (!l || l.includes('(') || l.includes(')') || l.startsWith('class ') || l.startsWith('interface ') || l.startsWith('public class ')) continue;
    const m = l.match(/^\s*(?:public\s+|protected\s+|private\s+|static\s+|final\s+|transient\s+|volatile\s+)*([a-zA-Z0-9_<>\[\]]+)\s+([a-zA-Z0-9_]+)\s*(?:=\s*([^;]+))?;\s*$/);
    if (!m) continue;
    fields.push({ name: m[2].trim(), type: m[1].trim(), default: (m[3] || '').trim() });
  }
  return fields;
}

// ─── Kotlin class/data class/object 필드 파서 (Kotlin Property Parser) ───
// val/var 프로퍼티만 추출. 메서드 시그니처/로컬 호출(괄호 포함 줄)과 람다(->)는 건너뛴다.
// (Extract val/var properties only; skip method signatures / local calls (lines with parens) and lambdas.)
function parseKotlinFields(body) {
  const fields = [];
  const lines = body.split('\n');
  for (const raw of lines) {
    let l = raw.replace(/\/\/.*/g, '').trim();
    if (!l || l.includes('(') || l.includes(')') || l.includes('->') ||
        l.startsWith('fun ') || l.startsWith('class ') || l.startsWith('object ') ||
        l.startsWith('interface ')) continue;
    const m = l.match(/^(?:(?:public|private|protected|internal|open|override|const|lateinit|final)\s+|@\w+\s+)*(?:val|var)\s+([a-zA-Z0-9_]+)\s*(?::\s*([^=]+?))?\s*(?:=\s*(.+))?$/);
    if (!m) continue;
    fields.push({ name: m[1].trim(), type: (m[2] || '').trim(), default: (m[3] || '').trim() });
  }
  return fields;
}

// Kotlin 주생성자 프로퍼티 파서 (Kotlin primary-constructor property parser).
// `class Foo(val a: Int, private val b: String = "x")` 에서 val/var 파라미터만 필드로 추출.
// (plain 파라미터 `name: Type` 은 프로퍼티가 아니므로 제외.)
function parseKotlinCtorFields(headerText) {
  if (!headerText) return [];
  const open = headerText.indexOf('(');
  if (open < 0) return [];
  let depth = 0, close = -1;
  for (let i = open; i < headerText.length; i++) {
    const c = headerText[i];
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) { close = i; break; } }
  }
  if (close < 0) return [];
  const inside = headerText.substring(open + 1, close);
  const fields = [];
  for (const raw of splitParamsTopLevel(inside)) {
    const p = raw.trim();
    if (!p) continue;
    const m = p.match(/^(?:@\w+(?:\([^)]*\))?\s*|(?:public|private|protected|internal|open|override|final|vararg)\s+)*(?:val|var)\s+([a-zA-Z0-9_]+)\s*(?::\s*([^=]+?))?\s*(?:=\s*([\s\S]+))?$/);
    if (!m) continue;
    fields.push({ name: m[1].trim(), type: (m[2] || '').trim(), default: (m[3] || '').trim() });
  }
  return fields;
}

// ─── JS/TS class/interface 필드 파서 (JS/TS Class/Interface Field Parser) ───
function parseJSFields(body) {
  const fields = [];
  const lines = body.split('\n');
  for (const raw of lines) {
    let l = raw.replace(/\/\/.*/g, '').trim();
    if (!l || l.includes('(') || l.includes(')') || l.startsWith('class ') || l.startsWith('interface ') || l.startsWith('export class ') || l.startsWith('export interface ')) continue;
    // JS/TS 프로퍼티 정규식 (JS/TS Property Regex)
    const m = l.match(/^\s*(?:(?:public|private|protected|readonly|static)\s+)*([a-zA-Z0-9_]+)(\?)?(?:\s*:\s*([^=;]+))?(?:\s*=\s*([^;]+))?;\s*$/);
    if (!m) continue;
    fields.push({
      name: m[1].trim(),
      type: (m[3] || '').trim(),
      default: (m[4] || '').trim()
    });
  }
  return fields;
}

// ─── Zig 식 분해 (Decompose Zig Expression) ───
function decomposeZigExpr(expr) {
  const e = expr.trim();
  if (!e) return null;
  const ops = [
    { sym: '||', tag: 'or' }, { sym: '&&', tag: 'and' },
    { sym: '==', tag: 'eq' }, { sym: '!=', tag: 'neq' },
    { sym: '<=', tag: 'leq' }, { sym: '>=', tag: 'geq' },
    { sym: '<',  tag: 'lt' },  { sym: '>',  tag: 'gt' },
    { sym: '+',  tag: 'add' }, { sym: '-',  tag: 'sub' },
    { sym: '*',  tag: 'mul' }, { sym: '/',  tag: 'div' },
  ];
  for (const { sym, tag } of ops) {
    let depth = 0;
    for (let i = 0; i < e.length - sym.length + 1; i++) {
      const ch = e[i];
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') depth--;
      else if (depth === 0 && e.substring(i, i + sym.length) === sym) {
        if ((sym === '+' || sym === '-') &&
            (i === 0 || /[+\-*\/=<>!&|(,?:%]/.test(e[i - 1]))) continue;
        return { op: tag, lhs: e.substring(0, i).trim(), rhs: e.substring(i + sym.length).trim() };
      }
    }
  }
  return null;
}

// ─── 재귀 stmt 파서 (Recursive Statement Parser) (Zig + MSL/C++ 공용 - Shared Zig + MSL/C++) ───
// MSL 은 C++ 서브셋. Zig 와 syntax 가 다르지만 (e.g. `}` 의미, 캡처 `|x|` 미사용) (MSL is a C++ subset. Although the syntax differs from Zig (e.g., meaning of `}`, capture `|x|` is not used))
// 핵심 구조 — if/while/for/return/generic stmt — 는 거의 동일하므로 재사용. (The core structure — if/while/for/return/generic stmt — is almost identical, so it is reused.)
class CStyleStmtParser {
  constructor(text, dialect = 'zig') {
    this.t = text;
    this.p = 0;
    this.dialect = dialect; // 'zig' | 'msl'
  }

  eof() { return this.p >= this.t.length; }
  peek(n = 0) { return this.t[this.p + n]; }

  skipWsComments() {
    while (!this.eof()) {
      const c = this.peek();
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { this.p++; continue; }
      if (this.t.substring(this.p, this.p + 2) === '//') {
        while (!this.eof() && this.peek() !== '\n') this.p++;
        continue;
      }
      if (this.t.substring(this.p, this.p + 2) === '/*') {
        this.p += 2;
        while (!this.eof() && this.t.substring(this.p, this.p + 2) !== '*/') this.p++;
        if (!this.eof()) this.p += 2;
        continue;
      }
      break;
    }
  }

  matchKeyword(kw) {
    this.skipWsComments();
    if (this.t.substring(this.p, this.p + kw.length) !== kw) return false;
    const after = this.t[this.p + kw.length];
    if (after !== undefined && /[a-zA-Z0-9_]/.test(after)) return false;
    this.p += kw.length;
    return true;
  }

  readBalancedParens() {
    this.skipWsComments();
    if (this.peek() !== '(') return null;
    let depth = 0;
    const start = this.p + 1;
    while (!this.eof()) {
      if (this.t.substring(this.p, this.p + 2) === '//') {
        while (!this.eof() && this.peek() !== '\n') this.p++;
        continue;
      }
      if (this.t.substring(this.p, this.p + 2) === '/*') {
        this.p += 2;
        while (!this.eof() && this.t.substring(this.p, this.p + 2) !== '*/') this.p++;
        if (!this.eof()) this.p += 2;
        continue;
      }
      const c = this.peek();
      if (c === '"') {
        this.p++;
        while (!this.eof() && this.peek() !== '"') {
          if (this.peek() === '\\' && !this.eof()) this.p++;
          this.p++;
        }
        if (!this.eof()) this.p++;
        continue;
      }
      if (c === "'") {
        this.p++;
        while (!this.eof() && this.peek() !== "'") {
          if (this.peek() === '\\' && !this.eof()) this.p++;
          this.p++;
        }
        if (!this.eof()) this.p++;
        continue;
      }
      if (c === '(') depth++;
      else if (c === ')') {
        depth--;
        if (depth === 0) {
          const inside = this.t.substring(start, this.p);
          this.p++;
          return inside;
        }
      }
      this.p++;
    }
    return null;
  }

  tryReadCapture() {
    if (this.dialect !== 'zig') return null;
    this.skipWsComments();
    if (this.peek() !== '|') return null;
    this.p++;
    const start = this.p;
    while (!this.eof() && this.peek() !== '|') this.p++;
    const cap = this.t.substring(start, this.p);
    if (this.peek() === '|') this.p++;
    return cap;
  }

  readBody() {
    this.skipWsComments();
    if (this.peek() === '{') return this.parseBlock();
    const s = this.parseStmt();
    return s ? [s] : [];
  }

  parseBlock() {
    this.skipWsComments();
    if (this.peek() !== '{') return [];
    this.p++;
    const stmts = [];
    while (!this.eof()) {
      this.skipWsComments();
      if (this.peek() === '}') { this.p++; return stmts; }
      const before = this.p;
      const s = this.parseStmt();
      if (s) stmts.push(s);
      else if (this.p === before) this.p++;
    }
    return stmts;
  }

  parseStmt() {
    this.skipWsComments();
    if (this.eof()) return null;
    if (this.peek() === '}') return null;

    if (this.matchKeyword('if'))     return this.parseIf();
    if (this.matchKeyword('while'))  return this.parseWhile();
    if (this.matchKeyword('for'))    return this.parseFor();
    if (this.matchKeyword('return')) return this.parseReturn();
    if (this.matchKeyword('switch')) return this.parseSwitch();
    if (this.matchKeyword('try'))    return this.parseTry();
    if (this.dialect === 'zig') {
      if (this.matchKeyword('defer'))    return this.parseDeferLike('defer');
      if (this.matchKeyword('errdefer')) return this.parseDeferLike('errdefer');
    }
    return this.parseGeneric();
  }

  parseIf() {
    const cond = (this.readBalancedParens() || '').trim();
    const capture = this.tryReadCapture();
    const thenBody = this.readBody();
    const elseBranches = [];
    while (true) {
      this.skipWsComments();
      if (!this.matchKeyword('else')) break;
      const elseCap = this.tryReadCapture();
      this.skipWsComments();
      if (this.matchKeyword('if')) {
        const c = (this.readBalancedParens() || '').trim();
        const cap2 = this.tryReadCapture();
        const b = this.readBody();
        elseBranches.push({ cond: c, capture: cap2 || elseCap, body: b });
      } else {
        const b = this.readBody();
        elseBranches.push({ cond: null, capture: elseCap, body: b });
        break;
      }
    }
    return { kind: 'if', cond, capture, then: thenBody, elseBranches };
  }

  parseWhile() {
    const cond = (this.readBalancedParens() || '').trim();
    const capture = this.tryReadCapture();
    let contExpr = null;
    if (this.dialect === 'zig') {
      this.skipWsComments();
      if (this.peek() === ':') {
        this.p++;
        this.skipWsComments();
        contExpr = (this.readBalancedParens() || '').trim();
      }
    }
    const body = this.readBody();
    return { kind: 'while', cond, capture, contExpr, body };
  }

  parseFor() {
    const range = (this.readBalancedParens() || '').trim();
    const capture = this.tryReadCapture();
    const body = this.readBody();
    return { kind: 'for', range, capture, body };
  }

  parseReturn() {
    const start = this.p;
    let depth = 0;
    while (!this.eof()) {
      if (this.t.substring(this.p, this.p + 2) === '//') {
        while (!this.eof() && this.peek() !== '\n') this.p++;
        continue;
      }
      if (this.t.substring(this.p, this.p + 2) === '/*') {
        this.p += 2;
        while (!this.eof() && this.t.substring(this.p, this.p + 2) !== '*/') this.p++;
        if (!this.eof()) this.p += 2;
        continue;
      }
      const c = this.peek();
      if (c === '"') {
        this.p++;
        while (!this.eof() && this.peek() !== '"') {
          if (this.peek() === '\\' && !this.eof()) this.p++;
          this.p++;
        }
        if (!this.eof()) this.p++;
        continue;
      }
      if (c === "'") {
        this.p++;
        while (!this.eof() && this.peek() !== "'") {
          if (this.peek() === '\\' && !this.eof()) this.p++;
          this.p++;
        }
        if (!this.eof()) this.p++;
        continue;
      }
      if (c === '(' || c === '[' || c === '{') { depth++; this.p++; continue; }
      if (c === ')' || c === ']' || c === '}') {
        if (depth === 0) break;
        depth--; this.p++; continue;
      }
      if (c === ';' && depth === 0) {
        const val = this.t.substring(start, this.p).trim();
        this.p++;
        return { kind: 'return', val };
      }
      this.p++;
    }
    return { kind: 'return', val: this.t.substring(start, this.p).trim() };
  }

  parseSwitch() {
    const expr = (this.readBalancedParens() || '').trim();
    const body = this.readBody();
    return { kind: 'switch', expr, body };
  }

  parseTry() {
    this.skipWsComments();
    let resource = null;
    if (this.peek() === '(') {
      resource = this.readBalancedParens();
    }
    const tryBody = this.readBody();
    const catches = [];
    let finallyBody = null;

    while (!this.eof()) {
      this.skipWsComments();
      if (this.matchKeyword('catch')) {
        const catchSig = (this.readBalancedParens() || '').trim();
        const catchBody = this.readBody();
        catches.push({ sig: catchSig, body: catchBody });
      } else if (this.matchKeyword('finally')) {
        finallyBody = this.readBody();
        break;
      } else {
        break;
      }
    }
    return { kind: 'try', resource, tryBody, catches, finallyBody };
  }

  parseDeferLike(kind) {
    const body = this.readBody();
    return { kind, body };
  }

  parseGeneric() {
    const start = this.p;
    let depth = 0;
    while (!this.eof()) {
      if (this.t.substring(this.p, this.p + 2) === '//') {
        while (!this.eof() && this.peek() !== '\n') this.p++;
        continue;
      }
      if (this.t.substring(this.p, this.p + 2) === '/*') {
        this.p += 2;
        while (!this.eof() && this.t.substring(this.p, this.p + 2) !== '*/') this.p++;
        if (!this.eof()) this.p += 2;
        continue;
      }
      const c = this.peek();
      if (c === '"') {
        this.p++;
        while (!this.eof() && this.peek() !== '"') {
          if (this.peek() === '\\' && !this.eof()) this.p++;
          this.p++;
        }
        if (!this.eof()) this.p++;
        continue;
      }
      if (c === "'") {
        this.p++;
        while (!this.eof() && this.peek() !== "'") {
          if (this.peek() === '\\' && !this.eof()) this.p++;
          this.p++;
        }
        if (!this.eof()) this.p++;
        continue;
      }
      if (c === '(' || c === '[' || c === '{') { depth++; this.p++; continue; }
      if (c === ')' || c === ']' || c === '}') {
        if (depth === 0) {
          const txt = this.t.substring(start, this.p).trim();
          return txt ? { kind: 'stmt', text: txt } : null;
        }
        depth--; this.p++; continue;
      }
      if (c === ';' && depth === 0) {
        const txt = this.t.substring(start, this.p).trim();
        this.p++;
        return txt ? { kind: 'stmt', text: txt } : null;
      }
      this.p++;
    }
    const txt = this.t.substring(start, this.p).trim();
    return txt ? { kind: 'stmt', text: txt } : null;
  }
}

// ─── stmt AST → 폴더 트리 (stmt AST to Folder Tree) ───
function emitStmtNode(stmt, parentPath, idx) {
  const prefix = `stmt_${idx}`;
  let stmtName;
  switch (stmt.kind) {
    case 'if': stmtName = `${prefix}__if`; break;
    case 'while': stmtName = `${prefix}__while`; break;
    case 'for': stmtName = `${prefix}__for`; break;
    case 'switch': stmtName = `${prefix}__switch`; break;
    case 'return': stmtName = `${prefix}__return`; break;
    case 'try': stmtName = `${prefix}__try`; break;
    case 'defer': stmtName = `${prefix}__defer`; break;
    case 'errdefer': stmtName = `${prefix}__errdefer`; break;
    default: stmtName = `${prefix}__expr`; break;
  }
  const dir = path.join(parentPath, safeName(stmtName));
  ensureDir(dir);

  if (stmt.kind === 'if') {
    const condTag = `cond___${safeName(stmt.cond).substring(0, 32)}`;
    const condDir = path.join(dir, condTag);
    ensureDir(condDir);
    if (stmt.capture) mkdirSync(path.join(condDir, `capture__${safeName(stmt.capture).substring(0, 24)}`));
    const thenDir = path.join(condDir, 'then');
    ensureDir(thenDir);
    emitStmtList(stmt.then || [], thenDir);
    annotateGeneric(stmt.cond, condDir);
    const branches = stmt.elseBranches || [];
    for (let bi = 0; bi < branches.length; bi++) {
      const br = branches[bi];
      const tag = br.cond === null ? 'else' : `elif_${bi}__cond___${safeName(br.cond).substring(0, 28)}`;
      const brDir = path.join(dir, tag);
      ensureDir(brDir);
      if (br.capture) mkdirSync(path.join(brDir, `capture__${safeName(br.capture).substring(0, 24)}`));
      emitStmtList(br.body || [], brDir);
      if (br.cond !== null) annotateGeneric(br.cond, brDir);
    }
    return;
  }
  if (stmt.kind === 'while') {
    const sigDir = path.join(dir, `cond___${safeName(stmt.cond).substring(0, 60)}`);
    ensureDir(sigDir);
    if (stmt.capture) mkdirSync(path.join(sigDir, `capture__${safeName(stmt.capture).substring(0, 40)}`));
    if (stmt.contExpr) mkdirSync(path.join(sigDir, `cont__${safeName(stmt.contExpr).substring(0, 40)}`));
    const bodyDir = path.join(dir, 'body');
    ensureDir(bodyDir);
    emitStmtList(stmt.body || [], bodyDir);
    return;
  }
  if (stmt.kind === 'for') {
    const sigDir = path.join(dir, `range___${safeName(stmt.range).substring(0, 60)}`);
    ensureDir(sigDir);
    if (stmt.capture) mkdirSync(path.join(sigDir, `capture__${safeName(stmt.capture).substring(0, 40)}`));
    const bodyDir = path.join(dir, 'body');
    ensureDir(bodyDir);
    emitStmtList(stmt.body || [], bodyDir);
    return;
  }
  if (stmt.kind === 'switch') {
    const sigDir = path.join(dir, `expr___${safeName(stmt.expr).substring(0, 60)}`);
    ensureDir(sigDir);
    const bodyDir = path.join(dir, 'body');
    ensureDir(bodyDir);
    emitStmtList(stmt.body || [], bodyDir);
    return;
  }
  if (stmt.kind === 'return') {
    if (stmt.val) {
      mkdirSync(path.join(dir, `val__${safeName(stmt.val).substring(0, 60)}`));
      annotateGeneric(stmt.val, dir);
    }
    return;
  }
  if (stmt.kind === 'try') {
    if (stmt.resource) {
      mkdirSync(path.join(dir, `resource___${safeName(stmt.resource).substring(0, 40)}`));
    }
    const tryBodyDir = path.join(dir, 'body');
    ensureDir(tryBodyDir);
    emitStmtList(stmt.tryBody || [], tryBodyDir);

    for (let ci = 0; ci < stmt.catches.length; ci++) {
      const c = stmt.catches[ci];
      const catchDir = path.join(dir, `catch___${safeName(c.sig).substring(0, 40)}`);
      ensureDir(catchDir);
      emitStmtList(c.body || [], catchDir);
    }
    if (stmt.finallyBody) {
      const finDir = path.join(dir, 'finally');
      ensureDir(finDir);
      emitStmtList(stmt.finallyBody || [], finDir);
    }
    return;
  }
  if (stmt.kind === 'defer' || stmt.kind === 'errdefer') {
    const bodyDir = path.join(dir, 'body');
    ensureDir(bodyDir);
    emitStmtList(stmt.body || [], bodyDir);
    return;
  }
  annotateGeneric(stmt.text || '', dir);
}

function emitStmtList(stmts, parentPath) {
  for (let i = 0; i < stmts.length; i++) emitStmtNode(stmts[i], parentPath, i);
}

// ─── Python 인덴테이션 기반 구문 분석기 (Python Indentation-based Parser) ───
class PythonIndentParser {
  constructor(lines) {
    this.lines = lines;
  }

  getIndent(line) {
    const m = line.match(/^(\s*)/);
    return m ? m[1].length : 0;
  }

  parse(startIndex = 0, parentIndent = -1) {
    const nodes = [];
    let i = startIndex;
    while (i < this.lines.length) {
      const line = this.lines[i];
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        i++;
        continue;
      }

      const indent = this.getIndent(line);
      if (indent <= parentIndent) {
        break;
      }

      let bodyLines = [];
      let j = i + 1;
      while (j < this.lines.length) {
        const nextLine = this.lines[j];
        const nextTrimmed = nextLine.trim();
        if (!nextTrimmed || nextTrimmed.startsWith('#')) {
          j++;
          continue;
        }
        const nextIndent = this.getIndent(nextLine);
        if (nextIndent > indent) {
          bodyLines.push(nextLine);
          j++;
        } else {
          break;
        }
      }

      let decorators = [];
      let k = i - 1;
      while (k >= 0) {
        const prevLine = this.lines[k];
        const prevTrim = prevLine.trim();
        if (prevTrim.startsWith('@')) {
          const decM = prevTrim.match(/^@([a-zA-Z0-9_.]+)(?:\((.*)\))?/);
          if (decM) {
            decorators.unshift({ name: decM[1], args: decM[2] || '' });
          }
          k--;
        } else if (!prevTrim || prevTrim.startsWith('#')) {
          k--;
        } else {
          break;
        }
      }

      let node = {
        line: trimmed,
        indent,
        index: i,
        decorators,
        body: bodyLines.length > 0 ? new PythonIndentParser(bodyLines).parse(0, indent) : []
      };

      let kind = 'stmt';
      let name = '';
      let m;
      if ((m = trimmed.match(/^class\s+([a-zA-Z0-9_]+)/))) {
        kind = 'class';
        name = m[1];
      } else if ((m = trimmed.match(/^(?:async\s+)?def\s+([a-zA-Z0-9_]+)/))) {
        kind = 'fn';
        name = m[1];
      } else if (trimmed.startsWith('if ') || trimmed.startsWith('if(')) {
        kind = 'if';
      } else if (trimmed.startsWith('elif ') || trimmed.startsWith('elif(')) {
        kind = 'elif';
      } else if (trimmed.startsWith('else:')) {
        kind = 'else';
      } else if (trimmed.startsWith('for ')) {
        kind = 'for';
      } else if (trimmed.startsWith('while ')) {
        kind = 'while';
      } else if (trimmed.startsWith('try:')) {
        kind = 'try';
      } else if (trimmed.startsWith('except ') || trimmed.startsWith('except:')) {
        kind = 'except';
      } else if (trimmed.startsWith('finally:')) {
        kind = 'finally';
      } else if (trimmed.startsWith('return ') || trimmed === 'return') {
        kind = 'return';
      } else if (trimmed.includes('=')) {
        const leftM = trimmed.match(/^([a-zA-Z0-9_]+)\s*(?::\s*[^=]+)?\s*=/);
        if (leftM && !trimmed.startsWith('if ') && !trimmed.startsWith('while ')) {
          kind = 'var';
          name = leftM[1];
        }
      }

      node.kind = kind;
      node.name = name;
      nodes.push(node);

      i = j;
    }
    return nodes;
  }
}

// ─── Python 노드 → 폴더 트리 실체화 (Python Node to Folder Tree Realization) ───
function emitPythonNode(node, parentPath, idx) {
  const prefix = `stmt_${idx}`;
  let stmtName = `${prefix}__expr`;

  if (node.kind === 'class') stmtName = `class__${safeName(node.name)}`;
  else if (node.kind === 'fn') stmtName = `fn__${safeName(node.name)}`;
  else if (node.kind === 'var') stmtName = `var__${safeName(node.name)}`;
  else if (node.kind === 'if') stmtName = `${prefix}__if`;
  else if (node.kind === 'elif') stmtName = `${prefix}__elif`;
  else if (node.kind === 'else') stmtName = `${prefix}__else`;
  else if (node.kind === 'for') stmtName = `${prefix}__for`;
  else if (node.kind === 'while') stmtName = `${prefix}__while`;
  else if (node.kind === 'try') stmtName = `${prefix}__try`;
  else if (node.kind === 'except') stmtName = `${prefix}__except`;
  else if (node.kind === 'finally') stmtName = `${prefix}__finally`;
  else if (node.kind === 'return') stmtName = `${prefix}__return`;

  const dir = path.join(parentPath, stmtName);
  ensureDir(dir);

  if (node.decorators && node.decorators.length > 0) {
    for (const dec of node.decorators) {
      const decDir = path.join(dir, `decorator__${safeName(dec.name)}`);
      mkdirSync(decDir);
      if (dec.args) {
        const parts = splitParamsTopLevel(dec.args);
        for (let ai = 0; ai < parts.length; ai++) {
          const p = parts[ai].trim();
          if (!p) continue;
          if (p.includes('=')) {
            const [k, v] = p.split('=').map(s => s.trim());
            const cleanV = v.replace(/["']/g, '');
            mkdirSync(path.join(decDir, `arg__${safeName(k)}___${safeName(cleanV).substring(0, 40)}`));
          } else {
            const cleanV = p.replace(/["']/g, '');
            mkdirSync(path.join(decDir, `arg__${ai}___${safeName(cleanV).substring(0, 40)}`));
          }
        }
      }
    }
  }

  if (node.kind !== 'class' && node.kind !== 'fn') {
    const line = node.line;
    const callMatches = line.matchAll(/\b([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g);
    for (const m of callMatches) {
      const callName = m[1];
      if (!/^(if|while|for|return|try|except|finally|import|from|class|def|print)$/.test(callName)) {
        ensureDir(path.join(dir, `call__${safeName(callName)}`));
      }
    }
  }

  if (node.body && node.body.length > 0) {
    const bodyDir = (node.kind === 'class' || node.kind === 'fn') ? dir : path.join(dir, 'body');
    ensureDir(bodyDir);
    emitPythonList(node.body, bodyDir);
  }
}

function emitPythonList(nodes, parentPath) {
  for (let i = 0; i < nodes.length; i++) {
    emitPythonNode(nodes[i], parentPath, i);
  }
}

function annotateGeneric(text, dir) {
  const stmt = (text || '').trim();
  if (!stmt) return;
  const children = [];
  const callMatches = stmt.matchAll(/\b([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g);
  for (const m of callMatches) {
    const callName = m[1];
    if (!/^(if|while|for|switch|return|try|catch|orelse|defer|errdefer|comptime|sizeof|static_cast|reinterpret_cast)$/.test(callName)) {
      children.push(`call__${callName}`);
    }
  }
  const varMatches = stmt.matchAll(/\b(?:const|var|auto|let)\s+([a-zA-Z0-9_]+)\b/g);
  for (const m of varMatches) children.push(`var__${m[1]}`);
  if (stmt.includes('==')) children.push('binop__equals');
  else if (stmt.includes('!=')) children.push('binop__not_equals');
  else if (stmt.includes('<=')) children.push('binop__leq');
  else if (stmt.includes('>=')) children.push('binop__geq');
  else if (stmt.includes('=')) children.push('assign');
  // CUDA / Metal 표식 (CUDA / Metal markers)
  if (stmt.includes('__syncthreads')) children.push('cuda__syncthreads');
  if (stmt.includes('__shfl')) children.push('cuda__shfl');
  if (stmt.includes('__shared__')) children.push('cuda__shared_decl');
  if (stmt.includes('threadgroup_barrier')) children.push('metal__threadgroup_barrier');
  if (stmt.includes('simd_shuffle')) children.push('metal__simd_shuffle');
  if (stmt.includes('simdgroup_barrier')) children.push('metal__simdgroup_barrier');
  if (stmt.includes('[[buffer(')) children.push('metal__buffer_attr');
  if (stmt.includes('[[thread_position')) children.push('metal__thread_pos');
  for (const c of children) ensureDir(path.join(dir, safeName(c)));

  const eqIdx = stmt.indexOf('=');
  if (eqIdx > 0 && !stmt.startsWith('if') && !stmt.includes('==') &&
      !stmt.includes('!=') && !stmt.includes('<=') && !stmt.includes('>=')) {
    const rhs = stmt.substring(eqIdx + 1).trim();
    const decomp = decomposeZigExpr(rhs);
    if (decomp) {
      const exprDir = path.join(dir, 'expr');
      ensureDir(exprDir);
      const opDir = path.join(exprDir, `bin_op__${decomp.op}`);
      ensureDir(opDir);
      if (decomp.lhs) mkdirSync(path.join(opDir, `lhs__${safeName(decomp.lhs).substring(0, 40)}`));
      if (decomp.rhs) mkdirSync(path.join(opDir, `rhs__${safeName(decomp.rhs).substring(0, 40)}`));
    }
  }
}

// ─── 엔진 (Engine) ───
class QuarkFolderEngine {
  constructor(outputDir) {
    this.outputDir = outputDir;
    this.quarkDir = path.join(outputDir, 'quark');
    this.mirrorDir = path.join(outputDir, '_mirror');
    this.axonDir = path.join(outputDir, '_axon');
    this.mirrors = { by_kind: {}, by_role: {}, by_file: {}, by_depth: {}, by_perf_band: {} };
    this.axons = [];
    this.byOpcodeSites = {};
    this.perfEntries = 0;
    this.symbols = []; // {name,kind,role,file,quark,startLine,endLine,signature} — quark_meta.json + 콜그래프 토대
  }

  init() {
    // v7: wipe ONLY the materialized-structure subtrees (quark/_mirror/_axon).
    // The derived perf layer (_hotpath/_ledger/_fingerprint/_dispatch) shares
    // this outDir and MUST persist across regens — _ledger is append-only
    // history. (Pre-v7 this rmSync'd the whole outDir, which would nuke the
    // ledger on the next regen; that folder collision is what v7 fixes.)
    for (const d of [this.quarkDir, this.mirrorDir, this.axonDir]) {
      if (fs.existsSync(d)) fs.rmSync(d, { recursive: true });
    }
    mkdirSync(this.outputDir);
    fs.writeFileSync(path.join(this.outputDir, OUTPUT_MARKER), 'quarkify output directory\n', 'utf-8');
    mkdirSync(this.quarkDir);
    mkdirSync(this.mirrorDir);
    mkdirSync(this.axonDir);
  }

  // 증분 빌드용 init: quark/ 는 보존(변경 파일만 갱신), 파생물(_mirror/_axon)만 재생성.
  initIncremental() {
    for (const d of [this.mirrorDir, this.axonDir]) {
      if (fs.existsSync(d)) fs.rmSync(d, { recursive: true });
    }
    mkdirSync(this.outputDir);
    fs.writeFileSync(path.join(this.outputDir, OUTPUT_MARKER), 'quarkify output directory\n', 'utf-8');
    mkdirSync(this.quarkDir);
    mkdirSync(this.mirrorDir);
    mkdirSync(this.axonDir);
  }

  // 변경되지 않은 파일의 캐시된 심볼을 복원 (재파싱 없이 미러/메타/콜그래프 토대 재구성).
  loadCachedSymbols(symbols) {
    for (const s of symbols || []) {
      this.symbols.push(s);
      this.registerMirror(s.kind, s.role, s.file, s.quark);
    }
  }

  // 한 소스 파일의 quark 폴더 삭제 (변경/삭제 파일 정리용)
  removeFileQuark(relPath) {
    const dir = path.join(this.quarkDir, `file__${safeName(relPath)}`);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
  }

  processFile(absPath, relPath) {
    const text = fs.readFileSync(absPath, 'utf-8');
    const lines = text.split('\n');
    const ext = path.extname(absPath);
    const fileFolderName = `file__${safeName(relPath)}`;
    const fileQuarkPath = path.join(this.quarkDir, fileFolderName);
    mkdirSync(fileQuarkPath);

    if (ext === '.ptx') { this.processPTX(text, fileQuarkPath, relPath); return; }
    if (ext === '.metal') { this.processMetal(text, fileQuarkPath, relPath); return; }
    if (ext === '.m' || ext === '.mm') { this.processObjC(text, fileQuarkPath, relPath); return; }
    if (ext === '.py') { this.processPython(text, fileQuarkPath, relPath); return; }

    // Zig / .cu / .cuh — symbol detection + recursive fn body for Zig
    this.processCStyle(text, lines, ext, fileQuarkPath, relPath);
  }

  processPython(text, fileQuarkPath, relPath) {
    const verClean = getPythonVersionClean();
    if (verClean) {
      mkdirSync(path.join(fileQuarkPath, `python_version__${verClean}`));
    }

    const lines = text.split('\n');
    const parser = new PythonIndentParser(lines);
    const nodes = parser.parse();

    emitPythonList(nodes, fileQuarkPath);

    const registerMirrorsRecursively = (n, parentPath = fileQuarkPath) => {
      let symPath = null, kind = null, role = null;
      if (n.kind === 'class') {
        kind = 'class'; role = 'type';
        symPath = path.join(parentPath, `class__${safeName(n.name)}`);
      } else if (n.kind === 'fn') {
        kind = 'fn'; role = guessRole(n.name);
        symPath = path.join(parentPath, `fn__${safeName(n.name)}`);
      }
      if (symPath) {
        const rel = path.relative(this.quarkDir, symPath);
        this.registerMirror(kind, role, relPath, rel);
        this.symbols.push({ name: n.name, kind, role, file: relPath, quark: rel,
          startLine: n.lineNo || null, endLine: null, signature: (n.line || n.name || '').trim().slice(0, 200) });
      }
      if (n.body) {
        const childParent = symPath || parentPath;
        for (const child of n.body) registerMirrorsRecursively(child, childParent);
      }
    };
    for (const n of nodes) registerMirrorsRecursively(n);
  }

  // ─── Zig / CUDA C++ (.cu/.cuh) ───
  processCStyle(text, lines, ext, fileQuarkPath, relPath, lineOffset = 0) {
    let cur = null;
    let depth = 0;
    let openedOnce = false;
    let symStart = 0;
    let parenDepth = 0; // Kotlin: 다중 라인 주 생성자/파라미터 목록 추적 (track multiline primary-constructor / param list)
    let pendingAnnotations = [];

    const finishSymbol = (endLine) => {
      if (!cur) return;
      const body = lines.slice(symStart, endLine).join('\n');
      const symFolderName = `${cur.kind}__${safeName(cur.name)}`;
      const symQuarkPath = path.join(fileQuarkPath, symFolderName);
      mkdirSync(symQuarkPath);

      if (cur.annotations && cur.annotations.length > 0) {
        for (const ann of cur.annotations) {
          const annDir = path.join(symQuarkPath, `annotation__${safeName(ann.name)}`);
          mkdirSync(annDir);
          if (ann.args) {
            const parts = splitParamsTopLevel(ann.args);
            for (let ai = 0; ai < parts.length; ai++) {
              const p = parts[ai].trim();
              if (!p) continue;
              if (p.includes('=')) {
                const [k, v] = p.split('=').map(s => s.trim());
                const cleanV = v.replace(/["']/g, '');
                mkdirSync(path.join(annDir, `arg__${safeName(k)}___${safeName(cleanV).substring(0, 40)}`));
              } else {
                const cleanV = p.replace(/["']/g, '');
                mkdirSync(path.join(annDir, `arg__${ai}___${safeName(cleanV).substring(0, 40)}`));
              }
            }
          }
        }
      }

      if (cur.kind === 'struct' || cur.kind === 'union' || cur.kind === 'enum' ||
          cur.kind === 'class' || cur.kind === 'namespace' || cur.kind === 'interface' ||
          cur.kind === 'record' || cur.kind === 'object' || cur.kind === 'impl') {
        const bodyOpen = body.indexOf('{');
        const bodyClose = body.lastIndexOf('}');
        const isKtContainer = (ext === '.kt' || ext === '.kts');
        // 헤더(= `{` 이전, 또는 본문이 없으면 전체) — Kotlin 주생성자가 여기 있다.
        const header = bodyOpen >= 0 ? body.substring(0, bodyOpen) : body;
        const hasBody = bodyOpen >= 0 && bodyClose > bodyOpen;
        const inner = hasBody ? body.substring(bodyOpen + 1, bodyClose) : '';

        let fields = [];
        if (ext === '.java') {
          fields = parseJavaFields(inner);
        } else if (isKtContainer) {
          // 주생성자 val/var + 본문 프로퍼티 (primary-constructor props + body props)
          fields = [...parseKotlinCtorFields(header), ...parseKotlinFields(inner)];
        } else if (ext === '.ts' || ext === '.js' || ext === '.tsx' || ext === '.jsx') {
          fields = parseJSFields(inner);
        } else {
          fields = parseZigStructFields(inner);
        }
        const seenField = new Set();
        for (const f of fields) {
          if (!f.name || seenField.has(f.name)) continue;
          seenField.add(f.name);
          const fDir = path.join(symQuarkPath, `field__${safeName(f.name)}`);
          mkdirSync(fDir);
          if (f.type) mkdirSync(path.join(fDir, `type__${safeName(f.type).substring(0, 60)}`));
          if (f.default) mkdirSync(path.join(fDir, `default__${safeName(f.default).substring(0, 60)}`));
          else mkdirSync(path.join(fDir, `default__missing__uninit_hazard`));
        }
        // RECURSE into the container body
        if (hasBody && (
            ((ext === '.go' || ext === '.rs' || ext === '.swift' || ext === '.cs') && /\b(?:fn|func)\s+[A-Za-z_]|\b(?:struct|enum|interface|trait|impl|class|protocol|extension)\s+[A-Za-z_]|[A-Za-z_][\w<>\[\],.?]*\s+[A-Za-z_]\w*\s*\(/.test(inner)) ||
            (isKtContainer && /\b(?:fun\s+[a-zA-Z0-9_]|(?:companion\s+)?object\b|(?:data\s+|enum\s+|sealed\s+|inner\s+)?class\s+[a-zA-Z_]|interface\s+[a-zA-Z_])/.test(inner)) ||
            /(?:^|\n)\s*(?:pub\s+)?(?:noinline\s+|inline\s+)?fn\s+[a-zA-Z0-9_]+\s*\(|(?:^|\n)\s*(?:pub\s+)?const\s+[a-zA-Z0-9_]+\s*=\s*(?:extern\s+|packed\s+)?(?:struct|union|enum)|(?:^|\n)\s*(?:template\s*<[^>]*>\s*)?(?:class|struct)\s+[a-zA-Z_]|\b(?:class|interface|enum|record)\s+[a-zA-Z0-9_]+|\b[a-zA-Z0-9_]+\s+[a-zA-Z0-9_]+\s*\([^;]*\{|\b(?:function)\b|=>/.test(inner))) {
          const innerLines = inner.split('\n');
          // inner 의 절대 시작 줄 = 현재 프레임 오프셋 + 심볼 시작 + body 내 inner 앞 줄바꿈 수
          const newlinesBeforeInner = (body.substring(0, bodyOpen + 1).match(/\n/g) || []).length;
          const innerOffset = lineOffset + symStart + newlinesBeforeInner;
          this.processCStyle(inner, innerLines, ext, symQuarkPath, relPath, innerOffset);
        }
      } else if (cur.kind === 'fn' && (ext === '.zig' || ext === '.java' || ext === '.kt' || ext === '.kts')) {
        const open = body.indexOf('{');
        const close = body.lastIndexOf('}');
        if (open >= 0 && close > open) {
          const inner = body.substring(open + 1, close);
          const parser = new CStyleStmtParser(inner, ext === '.zig' ? 'zig' : 'msl');
          const stmts = [];
          while (!parser.eof()) {
            parser.skipWsComments();
            if (parser.eof()) break;
            const before = parser.p;
            const s = parser.parseStmt();
            if (s) stmts.push(s);
            else if (parser.p === before) parser.p++;
          }
          emitStmtList(stmts, symQuarkPath);
        }
      } else {
        this.quarkifyBodyFlat(body, symQuarkPath);
      }

      this.registerMirror(cur.kind, cur.role, relPath, path.relative(this.quarkDir, symQuarkPath));
      // 심볼 메타데이터 기록 (jump-to-source 그라운딩 + 콜그래프 토대)
      const sig = (body.split('\n').find((l) => l.trim()) || '').trim().slice(0, 200);
      this.symbols.push({
        name: cur.name, kind: cur.kind, role: cur.role, file: relPath,
        quark: path.relative(this.quarkDir, symQuarkPath),
        startLine: lineOffset + symStart + 1,
        endLine: lineOffset + endLine,
        signature: sig,
      });
      cur = null;
    };

    // Kotlin 전용 심볼 종료 판정 (Kotlin-specific symbol completion):
    //  - 괄호 안(주 생성자/파라미터)이면 헤더가 끝나지 않았으므로 계속 누적
    //  - 블록 바디 `{`를 봤으면 brace depth 가 0 으로 닫힐 때 종료
    //  - 바디 `{`가 없으면(표현식 바디 `=`, data class 한 줄, 추상 fun, val/var) 해당 줄에서 종료
    //    단, 바로 다음 비어있지 않은 줄이 `{`로 시작하면 블록 바디가 따라오는 것이므로 대기
    const isKt = (ext === '.kt' || ext === '.kts');
    // 선택적 중괄호 언어(주생성자/표현식바디/유닛구조체 등) — Kotlin 식 유연 종료 판정을 공유.
    // (Languages with optional-brace decls share Kotlin's flexible completion logic.)
    const isFlex = isKt || ext === '.rs' || ext === '.swift' || ext === '.go' || ext === '.cs';
    const tryFinishKotlin = (i, openers, closers, oparens, cparens) => {
      parenDepth += oparens - cparens;
      depth += openers - closers;
      if (openers > 0) openedOnce = true;
      if (parenDepth > 0) return;
      if (openedOnce) { if (depth <= 0) finishSymbol(i + 1); return; }
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === '') j++;
      if (j < lines.length && lines[j].trim().startsWith('{')) return;
      finishSymbol(i + 1);
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const stripped = line.replace(/"(?:[^"\\]|\\.)*"/g, '').replace(/\/\/.*/g, '');
      const openers = (stripped.match(/\{/g) || []).length;
      const closers = (stripped.match(/\}/g) || []).length;
      const oparens = (stripped.match(/\(/g) || []).length;
      const cparens = (stripped.match(/\)/g) || []).length;
      if ((ext === '.java' || isKt) && !cur) {
        const annM = line.match(/^\s*@([a-zA-Z0-9_]+)(?:\((.*)\))?/);
        if (annM) {
          pendingAnnotations.push({ name: annM[1], args: annM[2] || '' });
        }
      }
      if (!cur) {
        let m, name, kind, role;
        if (ext === '.zig') {
          if ((m = line.match(/^\s*(?:pub\s+)?(?:noinline\s+|inline\s+)?fn\s+([a-zA-Z0-9_]+)\s*\(/))) {
            name = m[1]; kind = 'fn'; role = guessRole(name);
          } else if ((m = line.match(/^\s*(?:pub\s+)?const\s+([a-zA-Z0-9_]+)\s*=\s*(?:extern\s+|packed\s+)?struct/))) {
            name = m[1]; kind = 'struct'; role = 'type';
          } else if ((m = line.match(/^\s*(?:pub\s+)?const\s+([a-zA-Z0-9_]+)\s*=\s*(?:extern\s+|packed\s+)?union/))) {
            name = m[1]; kind = 'union'; role = 'type';
          } else if ((m = line.match(/^\s*(?:pub\s+)?const\s+([a-zA-Z0-9_]+)\s*=\s*enum/))) {
            name = m[1]; kind = 'enum'; role = 'type';
          } else if ((m = line.match(/^(?:pub\s+)?var\s+([a-zA-Z0-9_]+)\s*:/))) {
            name = m[1]; kind = 'var'; role = 'state';
          }
        } else if (ext === '.cu' || ext === '.cuh') {
          if ((m = line.match(/__global__\s+\w[\w\s\*&<>,]*?\s+([a-zA-Z0-9_]+)\s*\(/))) {
            name = m[1]; kind = 'kernel'; role = guessRole(name);
          } else if ((m = line.match(/__device__\s+\w[\w\s\*&<>,]*?\s+([a-zA-Z0-9_]+)\s*\(/))) {
            name = m[1]; kind = 'device_fn'; role = guessRole(name);
          } else if ((m = line.match(/^\s*(?:static\s+|inline\s+|extern\s+(?:"C"\s+)?)*\w[\w\s\*&<>,]*?\s+([a-zA-Z0-9_]+)\s*\([^;]*$/)) && !line.includes('=') && !line.match(/\breturn\b/)) {
            name = m[1]; kind = 'host_fn'; role = guessRole(name);
          } else if ((m = line.match(/^\s*struct\s+([a-zA-Z0-9_]+)\s*\{/))) {
            name = m[1]; kind = 'struct'; role = 'type';
          }
        } else if (ext === '.cpp' || ext === '.cc' || ext === '.cxx' || ext === '.h' || ext === '.hpp') {
          const trimmed = line.trim();
          if (trimmed.startsWith('#') || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.length === 0) {
          } else if ((m = line.match(/([a-zA-Z_][a-zA-Z0-9_]*)::([a-zA-Z_~][a-zA-Z0-9_]*)\s*\([^;]*$/)) && !line.match(/^\s*\/\//) && !line.match(/\breturn\b/) && line.indexOf('=') === -1) {
            name = `${m[1]}__${m[2]}`; kind = 'method'; role = guessRole(m[2]);
          } else if ((m = line.match(/^\s*(?:static\s+|inline\s+|virtual\s+|constexpr\s+|extern\s+(?:"C"\s+)?|template\s*<[^>]*>\s*)*[\w:<>,\s\*&]+?\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\([^;]*$/)) && !line.includes('=') && !line.match(/\breturn\b/) && !line.match(/^\s*(?:if|while|for|switch|return)\b/)) {
            name = m[1]; kind = 'fn'; role = guessRole(name);
          } else if ((m = line.match(/^\s*(?:template\s*<[^>]*>\s*)?(?:class|struct)\s+(?:[A-Z_]+\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\s*(?::[^{]*)?\s*\{/))) {
            name = m[1]; kind = (line.includes('class ') ? 'class' : 'struct'); role = 'type';
          } else if ((m = line.match(/^\s*(?:typedef\s+)?enum(?:\s+class)?\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*(?::[^{]*)?\s*\{/))) {
            name = m[1]; kind = 'enum'; role = 'type';
          } else if ((m = line.match(/^\s*namespace\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\{/))) {
            name = m[1]; kind = 'namespace'; role = 'namespace';
          }
        } else if (ext === '.java') {
          const trimmed = line.trim();
          if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.length === 0 || trimmed.startsWith('package ') || trimmed.startsWith('import ')) {
          } else if ((m = line.match(/^\s*(?:public\s+|protected\s+|private\s+|abstract\s+|static\s+|final\s+|sealed\s+|non-sealed\s+)*(class|interface|enum|record)\s+([a-zA-Z0-9_]+)/))) {
            name = m[2]; kind = m[1]; role = 'type';
          } else if ((m = line.match(/^\s*(?:public\s+|protected\s+|private\s+|static\s+|final\s+|synchronized\s+|abstract\s+|default\s+|native\s+|<[^>]+>\s*)*[a-zA-Z0-9_<>\[\]@\.]+\s+([a-zA-Z0-9_]+)\s*\([^;]*$/)) && !line.includes('=') && !line.match(/\breturn\b/) && !line.match(/^\s*(?:if|while|for|switch|return)\b/)) {
            name = m[1]; kind = 'fn'; role = guessRole(name);
          } else if ((m = line.match(/^\s*(?:public\s+|protected\s+|private\s+|static\s+|final\s+|transient\s+|volatile\s+)*[a-zA-Z0-9_<>\[\]]+\s+([a-zA-Z0-9_]+)\s*(?:=|;)/))) {
            name = m[1]; kind = 'var'; role = 'state';
          }
        } else if (ext === '.ts' || ext === '.js' || ext === '.tsx' || ext === '.jsx') {
          const trimmed = line.trim();
          if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.length === 0 || trimmed.startsWith('import ') || trimmed.startsWith('export *')) {
          } else if ((m = line.match(/^\s*(?:export\s+)?(class|interface)\s+([a-zA-Z0-9_]+)/))) {
            name = m[2]; kind = m[1]; role = 'type';
          } else if ((m = line.match(/^\s*(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z0-9_]+)\s*\(/))) {
            name = m[1]; kind = 'fn'; role = guessRole(name);
          } else if ((m = line.match(/^\s*(?:export\s+)?(?:const|let|var)\s+([a-zA-Z0-9_]+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[a-zA-Z0-9_]+)\s*=>/))) {
            name = m[1]; kind = 'fn'; role = guessRole(name);
          } else if ((m = line.match(/^\s*(?:export\s+)?(?:const|let|var)\s+([a-zA-Z0-9_]+)\s*=\s*(?:async\s+)?function\b/))) {
            name = m[1]; kind = 'fn'; role = guessRole(name);
          }
        } else if (isKt) {
          const trimmed = line.trim();
          const KMOD = '(?:(?:public|private|protected|internal|open|abstract|sealed|final|inner|value|annotation|data|override|inline|suspend|operator|infix|tailrec|external|const|lateinit|companion)\\s+)*';
          if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*') ||
              trimmed.length === 0 || trimmed.startsWith('package ') || trimmed.startsWith('import ') ||
              trimmed.startsWith('@')) {
            // 주석 / package / import / 단독 어노테이션 줄 (annotations captured separately above)
          } else if ((m = line.match(new RegExp(`^\\s*${KMOD}enum\\s+class\\s+([a-zA-Z0-9_]+)`)))) {
            name = m[1]; kind = 'enum'; role = 'type';
          } else if ((m = line.match(/^\s*companion\s+object(?:\s+([a-zA-Z0-9_]+))?/))) {
            name = m[1] || 'Companion'; kind = 'object'; role = 'type';
          } else if ((m = line.match(new RegExp(`^\\s*${KMOD}(class|interface|object)\\s+([a-zA-Z0-9_]+)`)))) {
            name = m[2]; kind = (m[1] === 'object' ? 'object' : m[1]);
            // 클래스명 기반 역할(controller/service 등)을 우선 적용, 없으면 'type'
            const r = guessRole(name); role = (r && r !== 'general') ? r : 'type';
          } else if ((m = line.match(new RegExp(`^\\s*${KMOD}fun\\s+(?:<[^>]+>\\s*)?(?:[a-zA-Z0-9_<>.?]+\\.)?([a-zA-Z0-9_]+)\\s*\\(`)))) {
            name = m[1]; kind = 'fn'; role = guessRole(name);
          } else if ((m = line.match(new RegExp(`^\\s*${KMOD}(?:val|var)\\s+([a-zA-Z0-9_]+)\\s*[:=]`)))) {
            name = m[1]; kind = 'var'; role = 'state';
          }
        } else if (ext === '.go') {
          const t = line.trim();
          if (t.startsWith('//') || t.startsWith('*') || t === '' || t.startsWith('package ') || t.startsWith('import ')) {
          } else if ((m = line.match(/^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/))) {
            name = m[1]; kind = 'fn'; role = guessRole(name);
          } else if ((m = line.match(/^\s*type\s+([A-Za-z_]\w*)\s+struct\b/))) {
            name = m[1]; kind = 'struct'; role = 'type';
          } else if ((m = line.match(/^\s*type\s+([A-Za-z_]\w*)\s+interface\b/))) {
            name = m[1]; kind = 'interface'; role = 'type';
          }
        } else if (ext === '.rs') {
          const t = line.trim();
          const RMOD = '(?:(?:pub(?:\\([^)]*\\))?|async|unsafe|const|extern(?:\\s+"[^"]*")?|default)\\s+)*';
          if (t.startsWith('//') || t.startsWith('*') || t === '' || t.startsWith('use ') || t.startsWith('#')) {
          } else if ((m = line.match(new RegExp(`^\\s*${RMOD}fn\\s+([A-Za-z_]\\w*)`)))) {
            name = m[1]; kind = 'fn'; role = guessRole(name);
          } else if ((m = line.match(new RegExp(`^\\s*${RMOD}struct\\s+([A-Za-z_]\\w*)`)))) {
            name = m[1]; kind = 'struct'; role = 'type';
          } else if ((m = line.match(new RegExp(`^\\s*${RMOD}enum\\s+([A-Za-z_]\\w*)`)))) {
            name = m[1]; kind = 'enum'; role = 'type';
          } else if ((m = line.match(new RegExp(`^\\s*${RMOD}trait\\s+([A-Za-z_]\\w*)`)))) {
            name = m[1]; kind = 'interface'; role = 'type';
          } else if ((m = line.match(/^\s*impl(?:\s*<[^>]*>)?\s+(?:[A-Za-z_][\w:<>, ]*\s+for\s+)?([A-Za-z_]\w*)/))) {
            name = m[1]; kind = 'impl'; role = 'type';
          }
        } else if (ext === '.swift') {
          const t = line.trim();
          const SMOD = '(?:(?:public|private|internal|fileprivate|open|final|static|class|override|mutating|convenience|required|@\\w+)\\s+)*';
          if (t.startsWith('//') || t.startsWith('*') || t === '' || t.startsWith('import ')) {
          } else if ((m = line.match(new RegExp(`^\\s*${SMOD}func\\s+([A-Za-z_]\\w*)`)))) {
            name = m[1]; kind = 'fn'; role = guessRole(name);
          } else if ((m = line.match(/^\s*(?:public\s+|private\s+|internal\s+|fileprivate\s+|open\s+|final\s+)*(class|struct|enum|protocol|extension)\s+([A-Za-z_]\w*)/))) {
            name = m[2]; kind = (m[1] === 'protocol' ? 'interface' : m[1] === 'extension' ? 'impl' : m[1]); role = 'type';
          }
        } else if (ext === '.cs') {
          const t = line.trim();
          const CSMOD = '(?:(?:public|private|protected|internal|static|sealed|abstract|partial|virtual|override|async|readonly|unsafe|new)\\s+)*';
          if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t === '' || t.startsWith('using ') || t.startsWith('namespace ') || t.startsWith('[')) {
          } else if ((m = line.match(new RegExp(`^\\s*${CSMOD}(class|interface|struct|enum|record)\\s+([A-Za-z_]\\w*)`)))) {
            name = m[2]; kind = (m[1] === 'record' ? 'class' : m[1]);
            const r = guessRole(name); role = (r && r !== 'general') ? r : 'type';
          } else if ((m = line.match(new RegExp(`^\\s*${CSMOD}[A-Za-z_][\\w<>\\[\\],.?]*\\s+([A-Za-z_]\\w*)\\s*\\(`))) && !line.match(/\b(?:if|while|for|foreach|switch|return|using|lock)\b/)) {
            name = m[1]; kind = 'method'; role = guessRole(name);
          }
        }
        if (name) {
          cur = { name, kind, role };
          cur.annotations = pendingAnnotations;
          pendingAnnotations = [];
          symStart = i;
          if (isFlex) {
            depth = 0; openedOnce = false; parenDepth = 0;
            tryFinishKotlin(i, openers, closers, oparens, cparens);
          } else {
            depth = openers - closers;
            openedOnce = openers > 0;
            if (cur.kind === 'var' && line.includes(';')) finishSymbol(i + 1);
            else if (openedOnce && depth <= 0) finishSymbol(i + 1);
          }
        }
      } else if (isFlex) {
        tryFinishKotlin(i, openers, closers, oparens, cparens);
      } else {
        depth += openers - closers;
        if (openers > 0) openedOnce = true;
        if (cur.kind === 'var' && line.includes(';')) finishSymbol(i + 1);
        else if (openedOnce && depth <= 0) finishSymbol(i + 1);
      }
    }
    finishSymbol(lines.length);
  }

  quarkifyBodyFlat(body, parentPath) {
    const cleanBody = body.replace(/\/\/.*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const statements = cleanBody.split(/(;|\{|\})/);
    let stmtIndex = 0;
    for (let stmt of statements) {
      stmt = stmt.trim();
      if (!stmt || stmt === ';' || stmt === '{' || stmt === '}') continue;
      let stmtName = '';
      const children = [];
      if (stmt.startsWith('if ') || stmt.startsWith('if(')) {
        stmtName = 'if';
        const condMatch = stmt.match(/if\s*\(([\s\S]*)\)/);
        if (condMatch) children.push(`cond___${safeName(condMatch[1]).substring(0, 40)}`);
      } else if (stmt.startsWith('while ') || stmt.startsWith('while(')) stmtName = 'while';
      else if (stmt.startsWith('for ') || stmt.startsWith('for(')) stmtName = 'for';
      else if (stmt.startsWith('return ') || stmt === 'return') {
        stmtName = 'return';
        const retVal = stmt.replace('return', '').trim();
        if (retVal) children.push(`val__${safeName(retVal).substring(0, 40)}`);
      } else if (stmt.startsWith('switch ') || stmt.startsWith('switch(')) stmtName = 'switch';
      else if (stmt.startsWith('asm')) {
        stmtName = `asm_${stmtIndex++}`;
        if (stmt.includes('dp4a')) children.push('inline_asm__dp4a');
        if (stmt.includes('mma.sync')) children.push('inline_asm__mma_sync');
        if (stmt.includes('cp.async')) children.push('inline_asm__cp_async');
      } else stmtName = `stmt_${stmtIndex++}`;
      const callMatches = stmt.matchAll(/\b([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g);
      for (const m of callMatches) {
        const callName = m[1];
        if (!/^(if|while|for|switch|return|try|catch|orelse|defer|errdefer|comptime|sizeof|static_cast|reinterpret_cast)$/.test(callName)) {
          children.push(`call__${callName}`);
        }
      }
      const varMatches = stmt.matchAll(/\b(?:const|var|auto)\s+([a-zA-Z0-9_]+)\b/g);
      for (const m of varMatches) children.push(`var__${m[1]}`);
      if (stmt.includes('==')) children.push('binop__equals');
      else if (stmt.includes('!=')) children.push('binop__not_equals');
      else if (stmt.includes('<=')) children.push('binop__leq');
      else if (stmt.includes('>=')) children.push('binop__geq');
      else if (stmt.includes('=')) children.push('assign');
      if (stmt.includes('__syncthreads')) children.push('cuda__syncthreads');
      if (stmt.includes('__shfl')) children.push('cuda__shfl');
      if (stmt.includes('__shared__')) children.push('cuda__shared_decl');
      const stmtPath = path.join(parentPath, safeName(stmtName));
      ensureDir(stmtPath);
      for (const c of children) ensureDir(path.join(stmtPath, safeName(c)));
      const eqIdx = stmt.indexOf('=');
      if (eqIdx > 0 && !stmt.startsWith('if') && !stmt.includes('==') &&
          !stmt.includes('!=') && !stmt.includes('<=') && !stmt.includes('>=')) {
        const rhs = stmt.substring(eqIdx + 1).trim();
        const decomp = decomposeZigExpr(rhs);
        if (decomp) {
          const exprDir = path.join(stmtPath, 'expr');
          ensureDir(exprDir);
          const opDir = path.join(exprDir, `bin_op__${decomp.op}`);
          ensureDir(opDir);
          if (decomp.lhs) mkdirSync(path.join(opDir, `lhs__${safeName(decomp.lhs).substring(0, 40)}`));
          if (decomp.rhs) mkdirSync(path.join(opDir, `rhs__${safeName(decomp.rhs).substring(0, 40)}`));
        }
      }
    }
  }

  // ─── Metal `.metal` (MSL: Metal Shading Language) ───
  // MSL = C++ subset. 핵심 디코드 (Core decodes):
  //   - `kernel void NAME(args) { ... }`    → kernel (PTX entry 와 동등 - equivalent to PTX entry)
  //   - `void NAME(args) { ... }`            → device_fn
  //   - `struct NAME { ... };`               → struct
  //   - param 안의 `[[buffer(N)]]`, `[[thread_position_in_grid]]` 등 attribute 캡처 (capturing attributes inside params)
  //   - storage qualifier: device / constant / threadgroup / thread
  processMetal(text, fileQuarkPath, relPath) {
    const lines = text.split('\n');
    const PERF_DATA = CONFIG.perfData || {};

    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      // kernel signature: 한 줄 또는 여러 줄에 걸침 (spans one or multiple lines)
      const km = line.match(/^\s*kernel\s+void\s+([a-zA-Z0-9_]+)\s*\(/);
      const fm = !km && line.match(/^\s*(?:static\s+|inline\s+)*(?:[a-zA-Z_][a-zA-Z0-9_]*(?:\s*<[^>]*>)?\s+[*&]*\s*|void\s+)([a-zA-Z0-9_]+)\s*\(/);
      const sm = !km && !fm && line.match(/^\s*struct\s+([a-zA-Z0-9_]+)\s*\{/);

      if (!km && !fm && !sm) { i++; continue; }

      let kind, role, entryName;
      if (km) {
        entryName = km[1]; kind = 'metal_kernel'; role = guessRole(entryName);
      } else if (fm) {
        // generic free function — 헷갈리니까 device_fn 으로 라벨 (labeled as device_fn to avoid confusion)
        // (host_fn 이 아니므로 — Metal MSL 은 host 코드 못 작성) (since it is not host_fn — Metal MSL cannot write host code)
        entryName = fm[1]; kind = 'device_fn'; role = guessRole(entryName);
      } else {
        entryName = sm[1]; kind = 'struct'; role = 'type';
      }

      // 시그니처/구조 끝까지 수집해서 본문 brace 찾기. (Collect signature/structure to the end to find body brace.)
      // 주의: Metal kernel 시그니처에는 `[[buffer(0)]]` 같은 attribute 가 포함되어 (Note: Metal kernel signature contains attributes like `[[buffer(0)]]`)
      // 그 안의 `()` 가 단순한 `.includes(')')` 매칭을 깨뜨림. 따라서 paren (which breaks simple `.includes(')')` matching inside. Thus,)
      // depth 를 추적하면서 unmatched `)` 가 닫힐 때까지 모은다. (tracking paren depth to collect until unmatched `)` is closed.)
      let sigLines = [line];
      let j = i + 1;
      if (kind === 'struct') {
        // already has '{'
      } else {
        let parenDepth = 0;
        for (const c of line) {
          if (c === '(') parenDepth++;
          else if (c === ')') parenDepth--;
        }
        while (j < lines.length && parenDepth > 0) {
          const nl = lines[j];
          for (const c of nl) {
            if (c === '(') parenDepth++;
            else if (c === ')') parenDepth--;
          }
          sigLines.push(nl);
          j++;
        }
      }

      // body brace scan — 라인 i 부터 첫 `{` 찾고 그 다음 줄을 bodyStart 로. (scan body brace — find first `{` from line i and set next line as bodyStart.)
      // 매칭 `}` 찾으면 bodyEnd. 단순하고 sigText 의존성 없음. (bodyEnd when matching `}` is found. Simple and has no dependency on sigText.)
      const sigText = sigLines.join('\n');
      let bodyStart = -1, bodyEnd = -1;
      let foundOpen = false;
      let bDepth = 0;
      let k = i;
      while (k < lines.length) {
        const L = lines[k];
        for (let ci = 0; ci < L.length; ci++) {
          const ch = L[ci];
          if (ch === '{') {
            bDepth++;
            if (!foundOpen) {
              foundOpen = true;
              // body content 는 `{` 다음 라인부터. (one-liner struct 의 인라인 body (body content starts from next line after `{`. (inlined body of one-liner struct)
              // 는 놓치지만 field parser 가 ; split 으로 견딘다.) (is missed, but field parser handles it via ; split))
              bodyStart = k + 1;
            }
          } else if (ch === '}') {
            bDepth--;
            if (bDepth === 0) { bodyEnd = k; break; }
          }
        }
        if (foundOpen && bDepth === 0) break;
        k++;
      }
      if (bodyStart < 0 || bodyEnd < 0) { i = j; continue; }

      const symFolderName = (kind === 'metal_kernel' ? `metal_kernel__` : kind === 'struct' ? `struct__` : `device_fn__`) + safeName(entryName);
      const symQuarkPath = path.join(fileQuarkPath, symFolderName);
      mkdirSync(symQuarkPath);

      if (kind !== 'struct') {
        // params 파싱: () 안의 콤마 분리 (Parsing params: split by comma inside ())
        const sigOnly = sigText.split('{')[0];
        const parenStart = sigOnly.indexOf('(');
        const parenEnd = sigOnly.lastIndexOf(')');
        if (parenStart >= 0 && parenEnd > parenStart) {
          const paramText = sigOnly.substring(parenStart + 1, parenEnd);
          const params = splitParamsTopLevel(paramText);
          for (let pi = 0; pi < params.length; pi++) {
            const p = params[pi].trim();
            if (!p) continue;
            // 형식: `device float* arg [[buffer(N)]]` / `constant uint& dim [[buffer(N)]]` (Format: `device float* arg [[buffer(N)]]` / `constant uint& dim [[buffer(N)]]`)
            // 이름 = `[[` 앞의 마지막 identifier (Name = last identifier before `[[`)
            const beforeAttr = p.replace(/\[\[[^\]]*\]\]/g, ' ').trim();
            const nameMatch = beforeAttr.match(/([a-zA-Z_][a-zA-Z0-9_]*)\s*$/);
            const pname = nameMatch ? nameMatch[1] : `arg${pi}`;
            const pdir = path.join(symQuarkPath, `param__${safeName(pname)}`);
            mkdirSync(pdir);
            // storage qualifier
            const sq = (p.match(/\b(device|constant|threadgroup|thread)\b/) || [])[1];
            if (sq) mkdirSync(path.join(pdir, `storage__${safeName(sq)}`));
            // type — qualifier + reference/pointer 떼고 마지막 type token (type — stripping qualifier + reference/pointer and getting last type token)
            const typeMatch = beforeAttr.match(/^\s*(?:device\s+|constant\s+|threadgroup\s+|thread\s+)?\s*((?:const\s+)?[a-zA-Z_][a-zA-Z0-9_]*(?:\s*<[^>]*>)?(?:\s*[*&])?)/);
            if (typeMatch) mkdirSync(path.join(pdir, `type__${safeName(typeMatch[1].trim()).substring(0, 40)}`));
            // attributes
            const attrs = (p.match(/\[\[[^\]]+\]\]/g) || []);
            for (const a of attrs) {
              const inner = a.replace(/\[\[|\]\]/g, '').trim();
              // buffer(N), thread_position_in_grid, threads_per_threadgroup 등 (buffer(N), thread_position_in_grid, threads_per_threadgroup, etc.)
              const tag = inner.replace(/\s+/g, '_').replace(/[()]/g, '_').substring(0, 40);
              mkdirSync(path.join(pdir, `attr__${safeName(tag)}`));
            }
          }
        }
        // 본문 재귀 파싱 — MSL 은 C++ 이므로 dialect 'msl' 로 (Recursive body parsing — MSL is C++, so dialect 'msl' is used)
        const innerBody = lines.slice(bodyStart, bodyEnd).join('\n');
        const parser = new CStyleStmtParser(innerBody, 'msl');
        const stmts = [];
        while (!parser.eof()) {
          parser.skipWsComments();
          if (parser.eof()) break;
          const before = parser.p;
          const s = parser.parseStmt();
          if (s) stmts.push(s);
          else if (parser.p === before) parser.p++;
        }
        emitStmtList(stmts, symQuarkPath);
      } else {
        // struct: 필드 파싱 (struct: parse fields)
        const innerBody = lines.slice(bodyStart, bodyEnd).join('\n');
        const fieldLines = innerBody.split(';');
        for (const fl of fieldLines) {
          const cleaned = fl.replace(/\/\/.*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').trim();
          if (!cleaned) continue;
          const m = cleaned.match(/^([a-zA-Z_][a-zA-Z0-9_]*(?:\s*<[^>]*>)?\s*[*&]*)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:\[(\d+)\])?\s*(?:=\s*(.+))?$/);
          if (!m) continue;
          const fDir = path.join(symQuarkPath, `field__${safeName(m[2])}`);
          mkdirSync(fDir);
          mkdirSync(path.join(fDir, `type__${safeName(m[1].trim()).substring(0, 40)}`));
          if (m[3]) mkdirSync(path.join(fDir, `array_size__${m[3]}`));
          if (m[4]) mkdirSync(path.join(fDir, `default__${safeName(m[4]).substring(0, 40)}`));
          else if (!m[4]) mkdirSync(path.join(fDir, `default__missing__uninit_hazard`));
        }
      }

      // perf data
      let perfBandTag = null;
      if (PERF_DATA[entryName]) {
        const perf = PERF_DATA[entryName];
        const perfDir = path.join(symQuarkPath, `_perf__measured`);
        mkdirSync(perfDir);
        for (const [key, val] of Object.entries(perf)) {
          const v = typeof val === 'number' ? String(val).replace('.', '_') : String(val);
          mkdirSync(path.join(perfDir, `${safeName(key)}__${safeName(v)}`));
        }
        if (typeof perf.dram_pct === 'number') {
          const band = perfBand(perf.dram_pct);
          mkdirSync(path.join(perfDir, `dram_band__${band}`));
          perfBandTag = band;
        }
        this.perfEntries++;
      }

      this.registerMirror(kind, role, relPath, path.relative(this.quarkDir, symQuarkPath), perfBandTag);
      i = bodyEnd + 1;
    }
  }

  // ─── Objective-C `.m` / `.mm` ───
  // 간단한 인터페이스/구현/메소드 캡처. 깊이있는 분해는 향후 작업. (Simple interface/implementation/method capture. Deep decomposition is future work.)
  processObjC(text, fileQuarkPath, relPath) {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // @interface NAME / @implementation NAME / @protocol NAME
      let m;
      if ((m = line.match(/^\s*@(interface|implementation|protocol)\s+([A-Za-z_][A-Za-z0-9_]*)/))) {
        const kind = `objc_${m[1]}`;
        const name = m[2];
        const role = guessRole(name);
        const dir = path.join(fileQuarkPath, `${kind}__${safeName(name)}`);
        mkdirSync(dir);
        this.registerMirror(kind, role, relPath, path.relative(this.quarkDir, dir));
        continue;
      }
      // method: - (RetType)name:args... { or + (RetType)...
      if ((m = line.match(/^\s*[-+]\s*\(([^)]+)\)\s*([A-Za-z_][A-Za-z0-9_:]*)/))) {
        const method = m[2].split(':')[0];
        const dir = path.join(fileQuarkPath, `objc_method__${safeName(method)}`);
        mkdirSync(dir);
        mkdirSync(path.join(dir, `ret_type__${safeName(m[1].trim()).substring(0, 40)}`));
        this.registerMirror('objc_method', guessRole(method), relPath, path.relative(this.quarkDir, dir));
        continue;
      }
    }
  }

  // ─── PTX (v3.1 그대로 - same as v3.1) ───
  processPTX(text, fileQuarkPath, relPath) {
    const PERF_DATA = CONFIG.perfData || {};
    const targetMatch = text.match(/\.target\s+([a-zA-Z0-9_]+)/);
    const versionMatch = text.match(/\.version\s+([0-9.]+)/);
    const target = targetMatch ? targetMatch[1] : 'unknown_target';
    const version = versionMatch ? versionMatch[1] : 'unknown_version';
    mkdirSync(path.join(fileQuarkPath, `target__${safeName(target)}`));
    mkdirSync(path.join(fileQuarkPath, `version__${safeName(version)}`));

    const lines = text.split('\n');
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      const em = line.match(/\.visible\s+\.entry\s+([a-zA-Z0-9_]+)\s*\(/);
      if (!em) { i++; continue; }
      const entryName = em[1];
      let sigLines = [line];
      let j = i + 1;
      while (j < lines.length && !sigLines.join(' ').includes(')')) { sigLines.push(lines[j]); j++; }
      const sigText = sigLines.join('\n');
      const paramMatch = sigText.match(/\(([\s\S]*?)\)/);
      const params = paramMatch ? paramMatch[1].split(',').map(s => s.trim()).filter(Boolean) : [];

      let depth = 0;
      let bodyStart = -1, bodyEnd = -1;
      let k = j;
      while (k < lines.length) { if (lines[k].includes('{')) { bodyStart = k + 1; depth = 1; k++; break; } k++; }
      while (k < lines.length && depth > 0) {
        for (const ch of lines[k]) {
          if (ch === '{') depth++;
          else if (ch === '}') { depth--; if (depth === 0) { bodyEnd = k; break; } }
        }
        if (depth === 0) break;
        k++;
      }
      if (bodyStart < 0 || bodyEnd < 0) { i = j; continue; }
      const bodyLines = lines.slice(bodyStart, bodyEnd);

      const role = guessRole(entryName);
      const symFolderName = `ptx_entry__${safeName(entryName)}`;
      const symQuarkPath = path.join(fileQuarkPath, symFolderName);
      mkdirSync(symQuarkPath);

      for (let pi = 0; pi < params.length; pi++) {
        const p = params[pi];
        const pm = p.match(/\.param\s+\.([a-z0-9_]+)\s+([a-zA-Z0-9_]+)/);
        const pname = pm ? pm[2] : `arg${pi}`;
        const ptype = pm ? pm[1] : null;
        const pdir = path.join(symQuarkPath, `param__${safeName(pname)}`);
        mkdirSync(pdir);
        if (ptype) mkdirSync(path.join(pdir, `type__${safeName(ptype)}`));
      }

      let curBlock = 'entry';
      let curBlockDir = path.join(symQuarkPath, `block__${safeName(curBlock)}`);
      mkdirSync(curBlockDir);
      const blockOpcodeIndices = { [curBlock]: {} };
      const regsByType = {};
      const blockSucc = {};
      const blockPred = {};
      const blockStmtCounter = { [curBlock]: 0 };
      let globalStmtIdx = 0;

      const incBlockOp = (block, op, idxInBlock) => {
        if (!blockOpcodeIndices[block]) blockOpcodeIndices[block] = {};
        if (!blockOpcodeIndices[block][op]) blockOpcodeIndices[block][op] = [];
        blockOpcodeIndices[block][op].push(idxInBlock);
      };

      for (const rawLine of bodyLines) {
        let l = rawLine.replace(/\/\/.*/g, '').trim();
        if (!l) continue;
        const shMatch = l.match(/^\.shared\s+(?:\.align\s+\d+\s+)?\.([a-z0-9_]+)\s+([a-zA-Z0-9_]+)\s*(?:\[(\d+)\])?\s*;/);
        if (shMatch) {
          const sDir = path.join(symQuarkPath, `shared__${safeName(shMatch[2])}`);
          mkdirSync(sDir);
          mkdirSync(path.join(sDir, `type__${safeName(shMatch[1])}`));
          if (shMatch[3]) mkdirSync(path.join(sDir, `size__${safeName(shMatch[3])}`));
          continue;
        }
        const regMatch = l.match(/^\.reg\s+\.([a-z0-9_]+)\s+(.*);$/);
        if (regMatch) {
          const typeKey = regMatch[1];
          if (!regsByType[typeKey]) regsByType[typeKey] = [];
          const regs = regMatch[2].split(',').map(s => s.trim()).filter(Boolean);
          for (const r of regs) {
            const nm = r.match(/^%([A-Za-z_][A-Za-z0-9_]*)/);
            if (nm) regsByType[typeKey].push(nm[1]);
          }
          continue;
        }
        const labelMatch = l.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*$/);
        if (labelMatch) {
          curBlock = labelMatch[1];
          curBlockDir = path.join(symQuarkPath, `block__${safeName(curBlock)}`);
          ensureDir(curBlockDir);
          if (!blockOpcodeIndices[curBlock]) blockOpcodeIndices[curBlock] = {};
          if (!(curBlock in blockStmtCounter)) blockStmtCounter[curBlock] = 0;
          continue;
        }
        const pieces = l.split(';').map(s => s.trim()).filter(Boolean);
        for (const piece of pieces) {
          let stmt = piece;
          let predTag = null;
          const pm = stmt.match(/^@(!?%?[A-Za-z_][A-Za-z0-9_]*)\s+(.*)$/);
          if (pm) { predTag = pm[1].replace(/[!%]/g, ''); stmt = pm[2].trim(); }
          const opM = stmt.match(/^([a-z][a-z0-9._]*)/);
          if (!opM) continue;
          const opcodeRaw = opM[1];
          const opcode = opcodeRaw.replace(/\./g, '_');
          const idxInBlock = blockStmtCounter[curBlock]++;
          incBlockOp(curBlock, opcode, idxInBlock);
          if (!this.byOpcodeSites[opcode]) this.byOpcodeSites[opcode] = [];
          this.byOpcodeSites[opcode].push({ entry: entryName, block: curBlock, stmtGlobal: globalStmtIdx, stmtInBlock: idxInBlock });
          const after = stmt.slice(opcodeRaw.length).trim();
          const args = after.split(',').map(s => s.trim()).filter(Boolean)
            .map(s => s.replace(/\[\s*([^\]]+?)\s*\]/g, 'addr_$1'));
          const stmtName = `stmt_${String(globalStmtIdx).padStart(4, '0')}__${opcode}${predTag ? '__pred_' + safeName(predTag) : ''}`;
          globalStmtIdx++;
          const stmtDir = path.join(curBlockDir, stmtName);
          ensureDir(stmtDir);
          if (predTag) mkdirSync(path.join(stmtDir, `pred__${safeName(predTag)}`));
          for (let ai = 0; ai < args.length && ai < 6; ai++) {
            const cls = classifyPtxArg(args[ai], opcode);
            const valTag = cls.value.replace(/[{}]/g, '').replace(/\s+/g, '_').substring(0, 40);
            const argDir = path.join(stmtDir, `arg${ai}__${safeName(valTag || cls.kind)}`);
            mkdirSync(argDir);
            mkdirSync(path.join(argDir, `kind__${cls.kind}`));
            if (cls.type) mkdirSync(path.join(argDir, `type__${safeName(cls.type)}`));
          }
          if (opcode === 'bra' && args.length >= 1) {
            const cls = classifyPtxArg(args[0], opcode);
            if (cls.kind === 'label') {
              const target = cls.value;
              mkdirSync(path.join(stmtDir, `target__block__${safeName(target)}`));
              if (!blockSucc[curBlock]) blockSucc[curBlock] = new Set();
              blockSucc[curBlock].add(target);
              if (!blockPred[target]) blockPred[target] = new Set();
              blockPred[target].add(curBlock);
            }
          }
        }
      }
      for (const [block, ops] of Object.entries(blockOpcodeIndices)) {
        const blockDir = path.join(symQuarkPath, `block__${safeName(block)}`);
        ensureDir(blockDir);
        for (const [op, indices] of Object.entries(ops)) {
          const opDir = path.join(blockDir, `opcode__${safeName(op)}__count_${indices.length}`);
          mkdirSync(opDir);
          for (const idx of indices) mkdirSync(path.join(opDir, `site__stmt_${String(idx).padStart(4, '0')}`));
        }
      }
      for (const [typeKey, regNames] of Object.entries(regsByType)) {
        const regGroupDir = path.join(symQuarkPath, `reg__${safeName(typeKey)}`);
        ensureDir(regGroupDir);
        mkdirSync(path.join(regGroupDir, `count__${regNames.length}`));
        const uniq = new Set(regNames);
        for (const rname of uniq) mkdirSync(path.join(regGroupDir, `name__${safeName(rname)}`));
      }
      for (const [block, succs] of Object.entries(blockSucc)) {
        const blockDir = path.join(symQuarkPath, `block__${safeName(block)}`);
        ensureDir(blockDir);
        for (const s of succs) mkdirSync(path.join(blockDir, `succ__block__${safeName(s)}`));
      }
      for (const [block, preds] of Object.entries(blockPred)) {
        const blockDir = path.join(symQuarkPath, `block__${safeName(block)}`);
        ensureDir(blockDir);
        for (const p of preds) mkdirSync(path.join(blockDir, `pred__block__${safeName(p)}`));
      }
      let perfBandTag = null;
      if (PERF_DATA[entryName]) {
        const perf = PERF_DATA[entryName];
        const perfDir = path.join(symQuarkPath, `_perf__measured`);
        mkdirSync(perfDir);
        for (const [key, val] of Object.entries(perf)) {
          const v = typeof val === 'number' ? String(val).replace('.', '_') : String(val);
          mkdirSync(path.join(perfDir, `${safeName(key)}__${safeName(v)}`));
        }
        if (typeof perf.dram_pct === 'number') {
          const band = perfBand(perf.dram_pct);
          mkdirSync(path.join(perfDir, `dram_band__${band}`));
          perfBandTag = band;
        }
        this.perfEntries++;
      }
      this.registerMirror('ptx_entry', role, relPath, path.relative(this.quarkDir, symQuarkPath), perfBandTag);
      i = k + 1;
    }
  }

  registerMirror(kind, role, file, relPath, perfBandTag) {
    if (!this.mirrors.by_kind[kind]) this.mirrors.by_kind[kind] = [];
    this.mirrors.by_kind[kind].push(relPath);
    if (!this.mirrors.by_role[role]) this.mirrors.by_role[role] = [];
    this.mirrors.by_role[role].push(relPath);
    const fileKey = safeName(file);
    if (!this.mirrors.by_file[fileKey]) this.mirrors.by_file[fileKey] = [];
    this.mirrors.by_file[fileKey].push(relPath);
    if (!this.mirrors.by_depth['depth_1']) this.mirrors.by_depth['depth_1'] = [];
    this.mirrors.by_depth['depth_1'].push(relPath);
    if (perfBandTag) {
      const bandKey = `dram_${perfBandTag}`;
      if (!this.mirrors.by_perf_band[bandKey]) this.mirrors.by_perf_band[bandKey] = [];
      this.mirrors.by_perf_band[bandKey].push(relPath);
    }
  }

  // 워커가 반환한 인메모리 누적 결과를 병합 (Merge a worker's accumulated in-memory result).
  // 폴더 산출물은 워커가 이미 디스크에 기록했으므로, 여기서는 미러/opcode/perf 메타만 합친다.
  // (Workers already wrote folders to disk; here we only merge the mirror/opcode/perf metadata.)
  mergeWorkerResult(r) {
    if (!r) return;
    for (const category of Object.keys(this.mirrors)) {
      const src = r.mirrors && r.mirrors[category];
      if (!src) continue;
      for (const [key, paths] of Object.entries(src)) {
        if (!this.mirrors[category][key]) this.mirrors[category][key] = [];
        this.mirrors[category][key].push(...paths);
      }
    }
    for (const [op, sites] of Object.entries(r.byOpcodeSites || {})) {
      if (!this.byOpcodeSites[op]) this.byOpcodeSites[op] = [];
      this.byOpcodeSites[op].push(...sites);
    }
    if (r.symbols) this.symbols.push(...r.symbols);
    this.perfEntries += r.perfEntries || 0;
  }

  // 심볼 메타데이터를 단일 JSON 으로 출력 (file:line 그라운딩 → AI 할루시네이션 억제)
  writeSymbolMeta() {
    const outFile = path.join(this.outputDir, 'quark_meta.json');
    fs.writeFileSync(outFile, JSON.stringify({ count: this.symbols.length, symbols: this.symbols }), 'utf-8');
    return outFile;
  }

  // 진짜 콜그래프: call__X 사이트를 실제 정의 심볼 quark 로 연결.
  // 각 call__X 폴더 밑에 resolves_to__<정의 quark 경로> 폴더를 만들어 엣지를 물리화한다.
  // (True call graph: link each call__X site to the defining symbol's quark by name.)
  buildCallGraph() {
    const CALLABLE = new Set(['fn', 'method', 'kernel', 'device_fn', 'host_fn']);
    // null-proto 객체: callee 가 'toString'/'constructor' 등 Object.prototype 키와 충돌하지 않게.
    const defIndex = Object.create(null); // 단순명 -> Set(quark 경로)
    const add = (k, v) => { (defIndex[k] || (defIndex[k] = new Set())).add(v); };
    for (const s of this.symbols) {
      if (!CALLABLE.has(s.kind)) continue;
      add(s.name, s.quark);
      if (s.name.includes('__')) add(s.name.split('__').pop(), s.quark); // C++ Class__method
    }
    let edges = 0;
    const callPrefix = 'call__';
    const walk = (dir) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        if (e.name.startsWith(callPrefix)) {
          const callee = e.name.slice(callPrefix.length);
          const defs = defIndex[callee];
          if (defs) {
            for (const d of defs) {
              mkdirSync(path.join(dir, e.name, `resolves_to__${safeName(d).substring(0, 90)}`));
              edges++;
            }
          }
          // call__ 은 잎으로 취급, 더 안 내려간다
        } else {
          walk(path.join(dir, e.name));
        }
      }
    };
    walk(this.quarkDir);
    this.callEdges = edges;
    return edges;
  }

  buildMirrors() {
    for (const [category, entries] of Object.entries(this.mirrors)) {
      const categoryDir = path.join(this.mirrorDir, category);
      mkdirSync(categoryDir);
      for (const [key, paths] of Object.entries(entries)) {
        const keyDir = path.join(categoryDir, safeName(key));
        mkdirSync(keyDir);
        for (const relPath of paths) {
          const entryDir = path.join(keyDir, safeName(relPath));
          mkdirSync(entryDir);
          this.axons.push({ quark: relPath, mirror: path.relative(this.outputDir, entryDir), category, key });
        }
      }
    }
  }

  buildAxons() {
    const axonIndex = {};
    for (const axon of this.axons) {
      const quarkKey = safeName(axon.quark);
      if (!axonIndex[quarkKey]) axonIndex[quarkKey] = [];
      axonIndex[quarkKey].push({ category: axon.category, key: axon.key });
    }
    for (const [quarkKey, connections] of Object.entries(axonIndex)) {
      const axonEntryDir = path.join(this.axonDir, quarkKey);
      mkdirSync(axonEntryDir);
      for (const conn of connections) mkdirSync(path.join(axonEntryDir, `${conn.category}__${safeName(conn.key)}`));
    }
    const byOpcodeDir = path.join(this.axonDir, 'by_opcode');
    mkdirSync(byOpcodeDir);
    for (const [op, sites] of Object.entries(this.byOpcodeSites)) {
      const opDir = path.join(byOpcodeDir, `opcode__${safeName(op)}__total_${sites.length}`);
      mkdirSync(opDir);
      const byEntry = {};
      for (const s of sites) { if (!byEntry[s.entry]) byEntry[s.entry] = []; byEntry[s.entry].push(s); }
      for (const [entry, entrySites] of Object.entries(byEntry)) {
        mkdirSync(path.join(opDir, `entry__${safeName(entry)}__sites_${entrySites.length}`));
      }
    }
  }

  getStats() {
    const countDirs = (dir) => {
      if (!fs.existsSync(dir)) return 0;
      let count = 0;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) { count++; count += countDirs(path.join(dir, entry.name)); }
      }
      return count;
    };
    return {
      quarkCount: countDirs(this.quarkDir),
      mirrorCount: countDirs(this.mirrorDir),
      axonCount: this.axons.length,
      perfEntries: this.perfEntries,
      opcodeFamilies: Object.keys(this.byOpcodeSites).length,
    };
  }

  collectTopologyGraphData() {
    const nodes = [];
    const links = [];
    const idMap = new Set();

    const addNode = (id, label, type, val = 1) => {
      if (idMap.has(id)) return;
      idMap.add(id);
      nodes.push({ id, label, type, val });
    };

    const addLink = (source, target, value = 1) => {
      links.push({ source, target, value });
    };

    const scanDir = (currPath, parentId = null) => {
      if (!fs.existsSync(currPath)) return;
      const entries = fs.readdirSync(currPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const fullPath = path.join(currPath, entry.name);
        const relPath = path.relative(this.quarkDir, fullPath);
        const nodeId = `quark::${relPath}`;

        let type = 'generic_stmt';
        let label = entry.name;
        if (entry.name.startsWith('file__')) { type = 'file'; label = entry.name.replace('file__', ''); }
        else if (entry.name.startsWith('class__')) { type = 'class'; label = entry.name.replace('class__', ''); }
        else if (entry.name.startsWith('interface__')) { type = 'interface'; label = entry.name.replace('interface__', ''); }
        else if (entry.name.startsWith('struct__')) { type = 'struct'; label = entry.name.replace('struct__', ''); }
        else if (entry.name.startsWith('fn__')) { type = 'function'; label = entry.name.replace('fn__', ''); }
        else if (entry.name.startsWith('field__')) { type = 'field'; label = entry.name.replace('field__', ''); }
        else if (entry.name.startsWith('var__')) { type = 'var'; label = entry.name.replace('var__', ''); }
        else if (entry.name.startsWith('annotation__')) { type = 'annotation'; label = '@' + entry.name.replace('annotation__', ''); }
        else if (entry.name.startsWith('stmt_')) { type = 'control_stmt'; }
        else if (entry.name.startsWith('call__')) { type = 'api_call'; label = entry.name.replace('call__', '') + '()'; }
        else if (entry.name.startsWith('cond__') || entry.name.startsWith('cond___')) { type = 'condition'; }
        else if (entry.name.startsWith('catch__') || entry.name.startsWith('catch___')) { type = 'catch'; }

        const sizeVal = type === 'file' ? 10 : type === 'class' ? 8 : type === 'function' ? 6 : type === 'annotation' ? 5 : 3;
        addNode(nodeId, label, type, sizeVal);

        if (parentId) {
          addLink(parentId, nodeId);
        }

        scanDir(fullPath, nodeId);
      }
    };

    scanDir(this.quarkDir);
    return { nodes, links };
  }

  writeHtmlViewer() {
    const graphData = this.collectTopologyGraphData();
    const htmlContent = `<!DOCTYPE html>
<html lang="ko">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Quarkify v1.0.0 Topology Viewer - ${CONFIG.name}</title>
    <!-- Tailwind CSS (CDN) -->
    <script src="https://cdn.tailwindcss.com"></script>
    <!-- D3.js (CDN) -->
    <script src="https://d3js.org/d3.v7.min.js"></script>
    <style>
        body {
            background-color: #0b0f19;
            color: #e2e8f0;
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            overflow: hidden;
        }
        .glass-panel {
            background: rgba(15, 23, 42, 0.65);
            backdrop-filter: blur(12px);
            -webkit-backdrop-filter: blur(12px);
            border: 1px solid rgba(255, 255, 255, 0.08);
        }
        .node:hover {
            cursor: pointer;
            filter: brightness(1.3);
        }
        .link {
            stroke: rgba(255, 255, 255, 0.06);
            stroke-opacity: 0.6;
        }
        .color-file { fill: #38bdf8; }
        .color-class { fill: #a855f7; }
        .color-interface { fill: #c084fc; }
        .color-struct { fill: #818cf8; }
        .color-function { fill: #f43f5e; }
        .color-field { fill: #10b981; }
        .color-var { fill: #34d399; }
        .color-annotation { fill: #fbbf24; }
        .color-control_stmt { fill: #64748b; }
        .color-api_call { fill: #f472b6; }
        .color-condition { fill: #06b6d4; }
        .color-catch { fill: #f97316; }
        .color-default { fill: #94a3b8; }
    </style>
</head>
<body class="w-screen h-screen flex relative">

    <div class="w-80 h-[92vh] glass-panel m-4 rounded-2xl p-6 flex flex-col z-10 shadow-2xl justify-between">
        <div>
            <h1 class="text-xl font-bold tracking-tight bg-gradient-to-r from-indigo-400 via-purple-400 to-pink-400 bg-clip-text text-transparent">
                Quarkify v1.0.0 ⚛️
            </h1>
            <p class="text-xs text-slate-400 mt-1">Topology Graph Visualizer</p>
            
            <div class="h-px bg-gradient-to-r from-transparent via-slate-700 to-transparent my-4"></div>
            
            <div class="space-y-3">
                <div>
                    <span class="text-xs text-slate-500 block">Project Name</span>
                    <span class="text-sm font-semibold text-slate-200">${CONFIG.name}</span>
                </div>
                <div>
                    <span class="text-xs text-slate-500 block">Total Nodes</span>
                    <span class="text-sm font-bold text-indigo-400">\${graphData.nodes.length}</span>
                </div>
                <div>
                    <span class="text-xs text-slate-500 block">Total Links</span>
                    <span class="text-sm font-bold text-purple-400">\${graphData.links.length}</span>
                </div>
            </div>
            
            <div class="h-px bg-gradient-to-r from-transparent via-slate-700 to-transparent my-4"></div>
            
            <h2 class="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">Legend</h2>
            <div class="grid grid-cols-2 gap-2 text-xs">
                <div class="flex items-center gap-1.5"><span class="w-2.5 h-2.5 rounded-full color-file"></span> <span class="text-slate-300">File</span></div>
                <div class="flex items-center gap-1.5"><span class="w-2.5 h-2.5 rounded-full color-class"></span> <span class="text-slate-300">Class</span></div>
                <div class="flex items-center gap-1.5"><span class="w-2.5 h-2.5 rounded-full color-function"></span> <span class="text-slate-300">Method</span></div>
                <div class="flex items-center gap-1.5"><span class="w-2.5 h-2.5 rounded-full color-annotation"></span> <span class="text-slate-300">Annotation</span></div>
                <div class="flex items-center gap-1.5"><span class="w-2.5 h-2.5 rounded-full color-field"></span> <span class="text-slate-300">Field/Var</span></div>
                <div class="flex items-center gap-1.5"><span class="w-2.5 h-2.5 rounded-full color-control_stmt"></span> <span class="text-slate-300">Control Stmt</span></div>
                <div class="flex items-center gap-1.5"><span class="w-2.5 h-2.5 rounded-full color-api_call"></span> <span class="text-slate-300">API Call</span></div>
                <div class="flex items-center gap-1.5"><span class="w-2.5 h-2.5 rounded-full color-condition"></span> <span class="text-slate-300">Condition</span></div>
            </div>
        </div>
        
        <div class="bg-slate-900/50 rounded-xl p-3 border border-slate-800/60" id="details">
            <span class="text-xs text-slate-500 block">Selected Node</span>
            <span class="text-sm font-semibold text-slate-300 block truncate" id="node-name">None (Click a node)</span>
            <span class="text-xs text-indigo-400 block mt-1" id="node-type">-</span>
        </div>
    </div>

    <div class="flex-1 h-full w-full absolute inset-0 z-0" id="graph-container"></div>

    <script>
        const data = ${JSON.stringify(graphData)};
        
        const container = document.getElementById('graph-container');
        const width = container.clientWidth;
        const height = container.clientHeight;
        
        const svg = d3.select("#graph-container")
            .append("svg")
            .attr("width", "100%")
            .attr("height", "100%")
            .attr("viewBox", [0, 0, width, height])
            .call(d3.zoom().on("zoom", (event) => {
                g.attr("transform", event.transform);
            }));
            
        const g = svg.append("g");
        
        const simulation = d3.forceSimulation(data.nodes)
            .force("link", d3.forceLink(data.links).id(d => d.id).distance(45))
            .force("charge", d3.forceManyBody().strength(-90))
            .force("center", d3.forceCenter(width / 2, height / 2))
            .force("collision", d3.forceCollide().radius(18));
            
        const link = g.append("g")
            .selectAll("line")
            .data(data.links)
            .join("line")
            .attr("class", "link");
            
        const node = g.append("g")
            .selectAll("circle")
            .data(data.nodes)
            .join("circle")
            .attr("r", d => d.val + 2)
            .attr("class", d => "node color-" + (d.type || "default"))
            .call(drag(simulation));
            
        const label = g.append("g")
            .selectAll("text")
            .data(data.nodes.filter(n => n.type === 'file' || n.type === 'class' || n.type === 'function' || n.type === 'annotation'))
            .join("text")
            .attr("dy", -10)
            .attr("text-anchor", "middle")
            .attr("fill", "#94a3b8")
            .attr("font-size", "10px")
            .text(d => d.label);

        node.on("click", (event, d) => {
            document.getElementById('node-name').innerText = d.label;
            document.getElementById('node-type').innerText = "Type: " + d.type.toUpperCase() + " | ID: " + d.id;
            node.transition().duration(200).attr("r", n => n.id === d.id ? n.val + 8 : n.val + 2);
        });
        
        simulation.on("tick", () => {
            link
                .attr("x1", d => d.source.x)
                .attr("y1", d => d.source.y)
                .attr("x2", d => d.target.x)
                .attr("y2", d => d.target.y);

            node
                .attr("cx", d => d.x)
                .attr("cy", d => d.y);
                
            label
                .attr("x", d => d.x)
                .attr("y", d => d.y);
        });
        
        function drag(simulation) {
            function dragstarted(event) {
                if (!event.active) simulation.alphaTarget(0.3).restart();
                event.subject.fx = event.subject.x;
                event.subject.fy = event.subject.y;
            }
            function dragged(event) {
                event.subject.fx = event.x;
                event.subject.fy = event.y;
            }
            function dragended(event) {
                if (!event.active) simulation.alphaTarget(0);
                event.subject.fx = null;
                event.subject.fy = null;
            }
            return d3.drag()
                .on("start", dragstarted)
                .on("drag", dragged)
                .on("end", dragended);
        }
    </script>
</body>
</html>`;
    const outPath = path.join(this.outputDir, 'index.html');
    fs.writeFileSync(outPath, htmlContent, 'utf-8');
    console.log(`[+] 인터랙티브 HTML 뷰어 빌드 완료: ${outPath}`);
  }

  // 다차원(3D) 토폴로지 뷰어 — three.js 기반 3d-force-graph. 2D(index.html)와 별개로 추가.
  // 깊이(z)까지 활용해 큰 그래프의 군집/계층을 입체로 탐색. 노드 색=종류, 크기=중요도.
  writeHtmlViewer3D() {
    const graphData = this.collectTopologyGraphData();
    const colorByType = {
      file: '#38bdf8', class: '#a855f7', interface: '#c084fc', struct: '#818cf8',
      function: '#f43f5e', field: '#10b981', var: '#34d399', annotation: '#fbbf24',
      control_stmt: '#64748b', api_call: '#f472b6', condition: '#06b6d4', catch: '#f97316',
    };
    const html = `<!DOCTYPE html>
<html lang="ko"><head><meta charset="UTF-8"><title>Quarkify 3D Topology - ${CONFIG.name}</title>
<style>
  body { margin:0; background:#05070d; color:#e2e8f0; font-family:-apple-system,sans-serif; overflow:hidden; }
  #info { position:absolute; top:12px; left:12px; z-index:10; background:rgba(15,23,42,.7);
          padding:12px 16px; border-radius:12px; border:1px solid rgba(255,255,255,.08); backdrop-filter:blur(8px); }
  #info h1 { margin:0 0 4px; font-size:16px; background:linear-gradient(90deg,#818cf8,#c084fc,#f472b6);
             -webkit-background-clip:text; background-clip:text; color:transparent; }
  #info .muted { color:#64748b; font-size:11px; }
  #legend { position:absolute; bottom:12px; left:12px; z-index:10; background:rgba(15,23,42,.7);
            padding:10px 14px; border-radius:12px; font-size:11px; max-width:200px; }
  #legend span { display:inline-block; margin:2px 6px 2px 0; }
  #legend i { display:inline-block; width:9px; height:9px; border-radius:50%; margin-right:4px; vertical-align:middle; }
</style>
<script src="https://unpkg.com/3d-force-graph"></script></head>
<body>
<div id="info"><h1>Quarkify 3D ⚛️</h1><div>${CONFIG.name}</div>
  <div class="muted">노드 ${graphData.nodes.length} · 링크 ${graphData.links.length} · 드래그=회전 / 스크롤=줌</div></div>
<div id="legend"></div>
<div id="graph"></div>
<script>
  const data = ${JSON.stringify(graphData)};
  const COLORS = ${JSON.stringify(colorByType)};
  const legend = document.getElementById('legend');
  legend.innerHTML = Object.entries(COLORS).map(([k,c]) => '<span><i style="background:'+c+'"></i>'+k+'</span>').join('');
  const Graph = ForceGraph3D()(document.getElementById('graph'))
    .graphData(data)
    .backgroundColor('#05070d')
    .nodeLabel(n => n.label + ' ('+n.type+')')
    .nodeColor(n => COLORS[n.type] || '#94a3b8')
    .nodeVal(n => n.val || 1)
    .nodeOpacity(0.9)
    .linkColor(() => 'rgba(255,255,255,0.12)')
    .linkWidth(0.4)
    .linkDirectionalParticles(1)
    .linkDirectionalParticleWidth(0.8)
    .onNodeClick(node => {
      const dist = 80;
      const ratio = 1 + dist/Math.hypot(node.x||1, node.y||1, node.z||1);
      Graph.cameraPosition({ x:(node.x||0)*ratio, y:(node.y||0)*ratio, z:(node.z||0)*ratio }, node, 1500);
    });
</script></body></html>`;
    const outPath = path.join(this.outputDir, 'index_3d.html');
    fs.writeFileSync(outPath, html, 'utf-8');
    console.log(`[+] 3D 토폴로지 뷰어 빌드 완료: ${outPath}`);
  }

  writeAiContextGuide() {
    const text = `================================================================================
🤖 AI 코딩 에이전트(LLM) 전용 위상 지도 네비게이션 가이드 (AI Context Guide)
================================================================================

본 디렉터리는 'Everything is a folder' 설계 철학에 따라 정적 분석 완료된 소스 코드 위상 맵입니다.
에이전트가 소스 코드를 읽거나 수정하는 작업을 진행할 때, 불필요한 토큰 낭비를 차단하고 
Hallucination을 방지하기 위해 다음 탐색 규칙을 반드시 준수하여 인지 구조를 최적화하십시오.

--------------------------------------------------------------------------------
📌 [핵심 행동 강령]
--------------------------------------------------------------------------------
1. ❌ 원본 코드 파일을 처음부터 끝까지 전체 다 읽지 마십시오. (심한 토큰 낭비 및 인지 오버헤드 유발)
2. 🔍 작업 공간 내의 '_mirror/' 또는 '_axon/' 구조적 스냅샷을 'list_dir' 도구로 먼저 확인하십시오.
3. 🎯 분석 또는 수정의 타겟이 되는 메서드(fn__) 폴더나 어노테이션(annotation__) 폴더 경로로 직행하십시오.
4. 🧠 최소한의 폴더 컨텍스트(Statement, Condition 등)만을 확인하고 작업 범위(Scope)를 제한하십시오.

--------------------------------------------------------------------------------
📂 [계층 폴더 구조 명세]
--------------------------------------------------------------------------------
* quark/
  └─ file__[파일명]/
     └─ [class/interface/struct]__[심볼명]/
        ├─ annotation__[어노테이션명]/    <-- 스프링 웹 엔드포인트 및 DI 정보 주입
        ├─ var__[멤버변수명]/
        └─ fn__[메서드명]/
           └─ stmt_idx__[구문유형]/        <-- if, while, return, try 등의 제어 흐름 분해

* _mirror/
  ├─ by_kind/     <-- 심볼의 종류별 모아보기 (class, struct, fn, var 등)
  ├─ by_role/     <-- 프로젝트 도메인 역할별 모아보기 (web_endpoint, business_logic 등)
  └─ by_file/     <-- 소스 파일별 연관 쿼크 모아보기

* _axon/          <-- 쿼크와 미러 폴더 간의 상호 의존성(의존 연결 관계) 및 Opcode 색인

--------------------------------------------------------------------------------
🛠️ [유용한 터미널 명령어 템플릿]
--------------------------------------------------------------------------------
* 특정 컨트롤러의 GetMapping 라우팅 및 try-catch 예외 흐름을 시각화할 때:
  $ tree [output_dir]/quark/file__[파일명].java/class__[클래스명]/fn__[메서드명]

* 프로젝트 내에서 특정 API 호출('call__...')을 수행하는 모든 노드 영역 탐색:
  $ fd -t d "call__[API명]" [output_dir]/quark

* 도메인 역할(예: web_endpoint)을 담당하는 모든 모듈 목록을 평평하게 조회:
  $ ls [output_dir]/_mirror/by_role/web_endpoint
================================================================================
`;
    const outPath = path.join(this.outputDir, 'ai_context_guide.txt');
    fs.writeFileSync(outPath, text, 'utf-8');
    console.log(`[+] AI 컨텍스트 가이드 지침서 작성 완료: ${outPath}`);
  }
}

// ─── 헬퍼 (Helpers) ───
function splitParamsTopLevel(text) {
  // depth-aware comma split (Metal params 의 [[ ]] 안 콤마는 무시 - ignores commas inside [[ ]] of Metal params)
  const out = [];
  let depth = 0, start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(' || c === '[' || c === '<') depth++;
    else if (c === ')' || c === ']' || c === '>') depth--;
    else if (c === ',' && depth === 0) {
      out.push(text.substring(start, i));
      start = i + 1;
    }
  }
  out.push(text.substring(start));
  return out;
}

// ─── Glob 파일 검색 및 매칭 헬퍼 (Glob File Search & Match Helpers) ───
const SKIP_DIRS = new Set(['.git', 'node_modules', 'build', 'dist', '.venv', 'venv',
  'target', '.next', '.gradle', '__pycache__', '.idea', '.quarkify-output', 'quark', '_mirror', '_axon']);

function getFilesRecursively(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const res = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) getFilesRecursively(res, files);
    } else {
      files.push(res);
    }
  }
  return files;
}

// Quarkify 가 분해할 수 있는 소스 확장자 (auto 모드/폴백에서 사용)
const SUPPORTED_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.py', '.kt', '.kts', '.java',
  '.go', '.rs', '.swift', '.cs', '.zig', '.cu', '.cuh',
  '.cpp', '.cc', '.cxx', '.h', '.hpp', '.metal', '.m', '.mm', '.ptx',
]);

// srcDir 전체를 훑어 지원 확장자 파일만 상대경로로 반환 (언어 자동 감지)
function autoScanSourceFiles() {
  const out = [];
  for (const abs of getFilesRecursively(CONFIG.srcDir)) {
    if (SUPPORTED_EXTS.has(path.extname(abs))) out.push(path.relative(CONFIG.srcDir, abs));
  }
  return out;
}

function matchGlobPattern(relPath, pattern) {
  const patternSegments = pattern.replace(/\\/g, '/').split('/').filter(Boolean);
  const relSegments = relPath.replace(/\\/g, '/').split('/').filter(Boolean);
  const memo = new Map();

  const segmentMatches = (segment, relSegment) => {
    const escaped = segment
      .replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
      .replace(/\*/g, '[^/]*');
    return new RegExp(`^${escaped}$`).test(relSegment);
  };

  const matchFrom = (patternIdx, relIdx) => {
    const key = `${patternIdx}:${relIdx}`;
    if (memo.has(key)) return memo.get(key);
    if (patternIdx === patternSegments.length) return relIdx === relSegments.length;

    const segment = patternSegments[patternIdx];
    let matched = false;
    if (segment === '**') {
      for (let nextRelIdx = relIdx; nextRelIdx <= relSegments.length; nextRelIdx++) {
        if (matchFrom(patternIdx + 1, nextRelIdx)) {
          matched = true;
          break;
        }
      }
    } else if (relIdx < relSegments.length && segmentMatches(segment, relSegments[relIdx])) {
      matched = matchFrom(patternIdx + 1, relIdx + 1);
    }

    memo.set(key, matched);
    return matched;
  };

  return matchFrom(0, 0);
}

function isSamePath(a, b) {
  return path.resolve(a) === path.resolve(b);
}

function validateOutputDir(outDir, srcDir) {
  if (typeof outDir !== 'string' || outDir.trim() === '') {
    throw new Error('unsafe output directory: outDir is required');
  }
  const resolvedOut = path.resolve(outDir);
  const resolvedSrc = fs.realpathSync(srcDir);
  const homeDir = os.homedir();
  const cwd = process.cwd();
  const root = path.parse(resolvedOut).root;
  const existingOut = fs.existsSync(resolvedOut) ? fs.realpathSync(resolvedOut) : resolvedOut;

  if (
    isSamePath(existingOut, root) ||
    isSamePath(existingOut, homeDir) ||
    isSamePath(existingOut, cwd) ||
    isSamePath(existingOut, resolvedSrc)
  ) {
    throw new Error(`unsafe output directory: ${resolvedOut}`);
  }

  if (fs.existsSync(existingOut)) {
    const entries = fs.readdirSync(existingOut);
    const hasMarker = entries.includes(OUTPUT_MARKER);
    if (entries.length > 0 && !hasMarker) {
      throw new Error(`output directory is not marked as Quarkify output: ${resolvedOut}`);
    }
  }
  return resolvedOut;
}

// CONFIG.sourceFiles 를 실제 상대경로 목록으로 해석 (글로브 지원). main 과 --k6 가 공유.
// (Resolve CONFIG.sourceFiles to a list of relative paths, supporting globs. Shared by main and --k6.)
function resolveSourceFiles({ verbose = false } = {}) {
  const list = CONFIG.sourceFiles || [];
  // auto 모드: sourceFiles 가 비었거나 'auto'/'**' 를 포함하면 언어 자동 감지.
  const wantsAuto = list.length === 0 || list.some(f => f === 'auto' || f === '**' || f === '**/*');
  if (wantsAuto) {
    const scanned = autoScanSourceFiles();
    if (verbose) console.log(`🔍 auto 모드: 지원 확장자 ${scanned.length}개 파일 자동 감지.\n`);
    return scanned;
  }
  const hasGlob = list.some(f => f.includes('*'));
  if (!hasGlob) return list;
  if (verbose) console.log('🔍 Glob 패턴 감지됨. 소스 디렉터리 스캔 중...');
  const resolved = [];
  for (const fileAbs of getFilesRecursively(CONFIG.srcDir)) {
    const fileRel = path.relative(CONFIG.srcDir, fileAbs);
    if (list.some(pat => matchGlobPattern(fileRel, pat))) resolved.push(fileRel);
  }
  // 무매칭 폴백: 글로브가 하나도 안 맞으면 죽지 말고 자동 감지로 폴백 (소비자 글로브가 틀려도 동작).
  if (resolved.length === 0) {
    const scanned = autoScanSourceFiles();
    if (scanned.length) {
      console.warn(`⚠️  지정한 glob 에 매칭된 파일이 없어 auto 감지로 폴백합니다 (${scanned.length}개).`);
      return scanned;
    }
  }
  if (verbose) console.log(`[+] 스캔 완료: 총 ${resolved.length}개 파일 매칭됨.\n`);
  return resolved;
}

// ─── main (Main Entry Point) ───
async function main() {
  console.log(`🔬 quarkify v1.0.0 — ${CONFIG.name} 시작...`);
  console.log(`📂 srcDir:  ${CONFIG.srcDir}`);
  console.log(`📁 outDir:  ${CONFIG.outDir}\n`);

  if (!fs.existsSync(CONFIG.srcDir)) {
    console.error(`❌ 에러: 설정된 소스 디렉터리(srcDir)가 존재하지 않습니다: "${CONFIG.srcDir}"`);
    console.error('설정 파일(*.mjs)의 srcDir 경로를 본인의 실제 로컬 경로로 수정해 주세요.');
    process.exit(1);
  }
  CONFIG.outDir = validateOutputDir(CONFIG.outDir, CONFIG.srcDir);

  // Glob 파일 스캔 및 매핑 (Glob File Scan and Mapping)
  const resolvedFiles = resolveSourceFiles({ verbose: true });

  if (resolvedFiles.length === 0) {
    console.error('❌ 에러: 매칭된 소스 파일이 하나도 없습니다.');
    console.error(`설정 파일의 'sourceFiles' 패턴(${JSON.stringify(CONFIG.sourceFiles)})과 'srcDir' 경로가 올바른지 확인해 주세요.`);
    process.exit(1);
  }

  const engine = new QuarkFolderEngine(CONFIG.outDir);

  // 증분 빌드 여부 (opt-in): CONFIG.incremental 또는 env QUARKIFY_INCREMENTAL
  const incrementalWanted = CONFIG.incremental === true || ['1', 'true', 'yes'].includes(String(process.env.QUARKIFY_INCREMENTAL || '').toLowerCase());
  const cachePath = path.join(CONFIG.outDir, '.quarkify-cache.json');
  let prevCache = null;
  if (incrementalWanted && fs.existsSync(cachePath) && fs.existsSync(engine.quarkDir)) {
    try { prevCache = JSON.parse(fs.readFileSync(cachePath, 'utf-8')); } catch { prevCache = null; }
  }
  const incremental = incrementalWanted && prevCache && prevCache.version === 1;

  // 존재하는 파일만 추려서 (abs, rel, hash) 목록 구성
  const present = [];
  for (const rel of resolvedFiles) {
    const abs = path.join(CONFIG.srcDir, rel);
    if (!fs.existsSync(abs)) { console.log(`[-] 건너뜀: ${rel}`); continue; }
    const hash = crypto.createHash('sha1').update(fs.readFileSync(abs)).digest('hex');
    present.push({ abs, rel, hash });
  }

  let jobs;
  if (incremental) {
    engine.initIncremental();
    const prevFiles = prevCache.files || {};
    const presentRels = new Set(present.map((p) => p.rel));
    // 삭제된 파일: quark 폴더 제거
    let deleted = 0;
    for (const rel of Object.keys(prevFiles)) {
      if (!presentRels.has(rel)) { engine.removeFileQuark(rel); deleted++; }
    }
    // 변경 없음: 캐시 심볼 복원 / 변경·신규: 작업 목록에
    jobs = [];
    let unchanged = 0;
    for (const p of present) {
      const cached = prevFiles[p.rel];
      const quarkExists = fs.existsSync(path.join(engine.quarkDir, `file__${safeName(p.rel)}`));
      if (cached && cached.hash === p.hash && quarkExists) {
        engine.loadCachedSymbols(cached.symbols);
        unchanged++;
      } else {
        engine.removeFileQuark(p.rel); // 변경분: 기존 폴더 정리 후 재생성
        jobs.push({ abs: p.abs, rel: p.rel });
      }
    }
    console.log(`♻️  증분 빌드: 변경/신규 ${jobs.length} · 변경없음 ${unchanged} · 삭제 ${deleted}`);
  } else {
    engine.init();
    jobs = present.map((p) => ({ abs: p.abs, rel: p.rel }));
  }

  const workerCount = resolveWorkerCount(jobs.length);
  if (workerCount <= 1) {
    // ─── 순차 처리 (Sequential) ───
    for (const { abs, rel } of jobs) {
      console.log(`[+] 분해 중: ${rel}`);
      engine.processFile(abs, rel);
    }
  } else {
    // ─── 병렬 처리 (Parallel via worker_threads) ───
    console.log(`⚙️  병렬 처리: ${jobs.length}개 파일 → ${workerCount}개 워커`);
    const chunks = chunkEvenly(jobs, workerCount);
    const results = await Promise.all(
      chunks.map((chunk, idx) => runWorkerChunk(chunk, CONFIG.outDir, cfgAbs, idx))
    );
    for (const r of results) engine.mergeWorkerResult(r);
  }

  console.log('\n🪞 미러 구성...');
  engine.buildMirrors();
  console.log('🔗 액손 + by_opcode 인덱스...');
  engine.buildAxons();
  console.log('🧬 콜그래프 링크...');
  const callEdges = engine.buildCallGraph();
  console.log('📇 심볼 메타데이터(quark_meta.json)...');
  engine.writeSymbolMeta();

  // 시각화 뷰어 및 AI 가이드 자동 생성 (Automatically generate visualization viewer and AI guide)
  engine.writeHtmlViewer();
  engine.writeHtmlViewer3D();
  engine.writeAiContextGuide();

  // 증분 빌드용 캐시 저장 (파일 해시 + 파일별 심볼). 다음 실행에서 변경분만 재처리.
  const symsByFile = {};
  for (const sym of engine.symbols) (symsByFile[sym.file] || (symsByFile[sym.file] = [])).push(sym);
  const cacheOut = { version: 1, files: {} };
  for (const p of present) cacheOut.files[p.rel] = { hash: p.hash, symbols: symsByFile[p.rel] || [] };
  fs.writeFileSync(cachePath, JSON.stringify(cacheOut), 'utf-8');

  const s = engine.getStats();
  console.log('\n=============================================');
  console.log(` 🎉 ${CONFIG.name} 쿼크나이제이션 완료!`);
  console.log('=============================================');
  console.log(` ⚛️  쿼크 폴더:        ${s.quarkCount}`);
  console.log(` 🪞 미러 폴더:        ${s.mirrorCount}`);
  console.log(` 🔗 액손:             ${s.axonCount}`);
  console.log(` 📊 perf 임베드:      ${s.perfEntries}`);
  console.log(` 🔣 opcode 종류:      ${s.opcodeFamilies}`);
  console.log(` 📁 경로:             ${path.resolve(CONFIG.outDir)}`);
  console.log('=============================================\n');
}
// ─── 병렬 처리 유틸 (Parallelism Utilities) ───

// 워커 수 결정 (Decide worker count).
// 우선순위: CONFIG.concurrency > env QUARKIFY_CONCURRENCY > 자동(cpu-1).
// 파일 수가 적으면(<MIN_PARALLEL_FILES) 워커 띄우는 오버헤드가 더 크므로 순차(=1).
function resolveWorkerCount(fileCount) {
  const MIN_PARALLEL_FILES = 16;
  const explicit = CONFIG.concurrency ?? process.env.QUARKIFY_CONCURRENCY;
  let want;
  if (explicit !== undefined && explicit !== null && explicit !== '') {
    want = parseInt(explicit, 10);
    if (!Number.isFinite(want) || want < 1) want = 1;
  } else {
    if (fileCount < MIN_PARALLEL_FILES) return 1;
    want = Math.max(1, (os.cpus()?.length || 1) - 1);
  }
  // 워커당 최소 몇 개 파일은 맡도록 상한 조정 (Cap so each worker handles a few files)
  return Math.max(1, Math.min(want, Math.ceil(fileCount / 4), fileCount));
}

// 작업을 워커 수만큼 거의 균등하게 분할 (Split jobs into ~even chunks)
function chunkEvenly(items, n) {
  const chunks = Array.from({ length: n }, () => []);
  for (let i = 0; i < items.length; i++) chunks[i % n].push(items[i]);
  return chunks.filter((c) => c.length > 0);
}

// 워커 하나를 띄워 청크를 처리하고, 누적된 mirror/opcode/perf 메타를 받아온다.
// (Spawn a worker to process a chunk and collect its accumulated metadata.)
function runWorkerChunk(jobs, outDir, configPath, idx) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(fileURLToPath(import.meta.url), {
      workerData: { jobs, outDir, configPath },
    });
    worker.once('message', (msg) => resolve(msg));
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`워커 #${idx} 비정상 종료 (exit code ${code})`));
    });
  });
}

// 워커 스레드 진입점: 할당된 파일들을 처리하고 메타를 부모로 전송.
// init() 은 메인에서 1회만 수행하므로 워커는 절대 호출하지 않는다 (출력 디렉터리를 지워버림).
// (Worker entry point: process assigned files, post metadata back. Never call init() — main owns it.)
async function runWorker() {
  const { jobs, outDir } = workerData;
  const engine = new QuarkFolderEngine(outDir);
  for (const { abs, rel } of jobs) {
    try {
      engine.processFile(abs, rel);
    } catch (err) {
      console.error(`[!] 워커 처리 실패: ${rel} — ${err && err.message ? err.message : err}`);
    }
  }
  parentPort.postMessage({
    mirrors: engine.mirrors,
    byOpcodeSites: engine.byOpcodeSites,
    perfEntries: engine.perfEntries,
    symbols: engine.symbols,
  });
}

// ─── 역방향: 폴더 트리 ↔ 단일 파일 (Reverse: folder tree <-> single file) ───
// ⚠️ 주의: forward 변환은 손실(lossy)이라 '원본 소스 코드' 복원은 불가능하다.
//    아래 collapse/expand 는 "폴더 토폴로지 ↔ 단일 JSON" 사이의 무손실 왕복만 보장한다.
//    (forward is lossy; these only round-trip the folder topology, not the original source.)

// 디렉터리 서브트리를 중첩 객체로 직렬화. 모든 quark 폴더는 비어있는 디렉터리이므로
// {폴더명: {자식...}} 형태면 완전한 표현이 된다. (Serialize a dir subtree to nested object.)
function collapseTree(dir) {
  const out = {};
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    throw new Error(`디렉터리를 읽을 수 없습니다: ${dir} (${err.message})`);
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    if (e.isDirectory()) out[e.name] = collapseTree(path.join(dir, e.name));
  }
  return out;
}

// 중첩 객체의 노드 수(=폴더 수) 카운트 (Count nodes in the nested tree)
function countTreeNodes(node) {
  let n = 0;
  for (const child of Object.values(node)) { n++; n += countTreeNodes(child); }
  return n;
}

// 사람이 읽을 수 있는 들여쓰기 트리 텍스트 (Human-readable indented tree text)
function renderTreeText(node, prefix = '') {
  const keys = Object.keys(node);
  let out = '';
  keys.forEach((key, i) => {
    const last = i === keys.length - 1;
    out += `${prefix}${last ? '└── ' : '├── '}${key}\n`;
    out += renderTreeText(node[key], prefix + (last ? '    ' : '│   '));
  });
  return out;
}

// 중첩 객체를 다시 폴더 트리로 실체화 (Re-materialize the nested object into folders)
function expandTree(node, targetDir) {
  mkdirSync(targetDir);
  for (const [name, child] of Object.entries(node)) {
    expandTree(child, path.join(targetDir, name));
  }
}

async function runCollapse() {
  const target = process.argv[3];
  if (!target) {
    console.error('사용법: node quarkify.mjs --collapse <outDir|quarkDir> [outFile.json]');
    process.exit(1);
  }
  const resolved = path.resolve(target);
  if (!fs.existsSync(resolved)) {
    console.error(`❌ 에러: 경로가 존재하지 않습니다: ${resolved}`);
    process.exit(1);
  }
  // <outDir>/quark 가 있으면 그걸, 아니면 주어진 경로 자체를 collapse.
  const quarkSub = path.join(resolved, 'quark');
  const rootDir = fs.existsSync(quarkSub) ? quarkSub : resolved;
  const rootName = path.basename(rootDir);

  console.log(`🗜️  collapse: ${rootDir} → 단일 파일`);
  const tree = { [rootName]: collapseTree(rootDir) };
  const nodeCount = countTreeNodes(tree);

  const outFile = process.argv[4]
    ? path.resolve(process.argv[4])
    : path.join(resolved, 'quark_tree.json');
  const txtFile = outFile.replace(/\.json$/i, '') + '.txt';

  fs.writeFileSync(outFile, JSON.stringify(tree), 'utf-8');
  fs.writeFileSync(txtFile, renderTreeText(tree), 'utf-8');

  const jsonKb = (fs.statSync(outFile).size / 1024).toFixed(1);
  console.log('=============================================');
  console.log(' 🎉 collapse 완료!');
  console.log('=============================================');
  console.log(` ⚛️  폴더(노드) 수:   ${nodeCount}`);
  console.log(` 📄 JSON:             ${outFile} (${jsonKb} KB)`);
  console.log(` 📄 트리 텍스트:      ${txtFile}`);
  console.log(` ↩️  복원:            node quarkify.mjs --expand "${outFile}" <targetDir>`);
  console.log('=============================================\n');
}

async function runExpand() {
  const treeFile = process.argv[3];
  const targetDir = process.argv[4];
  if (!treeFile || !targetDir) {
    console.error('사용법: node quarkify.mjs --expand <tree.json> <targetDir>');
    process.exit(1);
  }
  const resolvedTree = path.resolve(treeFile);
  if (!fs.existsSync(resolvedTree)) {
    console.error(`❌ 에러: 트리 파일이 존재하지 않습니다: ${resolvedTree}`);
    process.exit(1);
  }
  let tree;
  try {
    tree = JSON.parse(fs.readFileSync(resolvedTree, 'utf-8'));
  } catch (err) {
    console.error(`❌ 에러: JSON 파싱 실패: ${err.message}`);
    process.exit(1);
  }
  const resolvedTarget = path.resolve(targetDir);
  console.log(`🌳 expand: ${resolvedTree} → ${resolvedTarget}`);
  expandTree(tree, resolvedTarget);
  const nodeCount = countTreeNodes(tree);
  console.log('=============================================');
  console.log(' 🎉 expand 완료!');
  console.log('=============================================');
  console.log(` ⚛️  복원된 폴더 수:  ${nodeCount}`);
  console.log(` 📁 경로:             ${resolvedTarget}`);
  console.log('=============================================\n');
}

// ─── k6 부하테스트 생성 (k6 Load-test Generation) ───
// 정확도를 위해 quark 폴더(손실됨)가 아니라 *원본 소스*에서 엔드포인트를 추출한다.
// (Extract endpoints from the original source — not the lossy quark tree — for accurate URLs.)

const SPRING_METHOD = { GetMapping: 'GET', PostMapping: 'POST', PutMapping: 'PUT', DeleteMapping: 'DELETE', PatchMapping: 'PATCH' };

// 어노테이션 인자 문자열에서 경로 추출 (value=/path=/첫 문자열 리터럴)
function annPathArg(body) {
  if (!body) return '';
  let m = body.match(/(?:value|path)\s*=\s*["']([^"']*)["']/);
  if (m) return m[1];
  m = body.match(/["']([^"']*)["']/);
  return m ? m[1] : '';
}

function joinPath(base, sub) {
  let b = (base || '').trim();
  let s = (sub || '').trim();
  if (b && !b.startsWith('/')) b = '/' + b;
  if (b.endsWith('/')) b = b.slice(0, -1);
  if (s && !s.startsWith('/')) s = '/' + s;
  const joined = (b + s) || '/';
  return joined.replace(/\/{2,}/g, '/');
}

// Spring(@RestController) — Java/Kotlin 공용 (shared by Java/Kotlin)
function extractSpringEndpoints(text) {
  const endpoints = [];
  // 클래스 베이스 경로: 첫 메서드 매핑 이전에 나오는 @RequestMapping 의 경로 (class-level base)
  const firstMethodIdx = (() => {
    const m = text.match(/@(?:Get|Post|Put|Delete|Patch)Mapping\b/);
    return m ? m.index : text.length;
  })();
  let basePath = '';
  const baseRe = /@RequestMapping\s*(?:\(([^)]*)\))?/g;
  let bm;
  while ((bm = baseRe.exec(text)) !== null) {
    if (bm.index >= firstMethodIdx) break;
    const p = annPathArg(bm[1] || '');
    if (p) { basePath = p; }
  }
  // 메서드 매핑들 (@GetMapping 등)
  const re = /@(Get|Post|Put|Delete|Patch)Mapping\s*(?:\(([^)]*)\))?/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const method = SPRING_METHOD[`${m[1]}Mapping`];
    const sub = annPathArg(m[2] || '');
    endpoints.push({ method, path: joinPath(basePath, sub), bodyType: springBodyType(text, m.index) });
  }
  // @RequestMapping(method = RequestMethod.GET, value="/x") 형태의 메서드 매핑
  const rm = /@RequestMapping\s*\(([^)]*method\s*=\s*RequestMethod\.[^)]*)\)/g;
  while ((m = rm.exec(text)) !== null) {
    const methodM = m[1].match(/RequestMethod\.(\w+)/);
    if (!methodM) continue;
    endpoints.push({ method: methodM[1].toUpperCase(), path: joinPath(basePath, annPathArg(m[1])), bodyType: springBodyType(text, m.index) });
  }
  return endpoints;
}

// 메서드 시그니처에서 @RequestBody 의 타입명 추출 (Kotlin `name: Type` / Java `Type name`).
function springBodyType(text, fromIdx) {
  const braceIdx = text.indexOf('{', fromIdx);
  const win = text.substring(fromIdx, braceIdx < 0 ? fromIdx + 500 : braceIdx);
  const rb = win.match(/@RequestBody\b[^,)]*?(?::\s*([A-Za-z_]\w*)|\b([A-Z][A-Za-z0-9_]*)\s+\w+)/);
  return rb ? (rb[1] || rb[2]) : null;
}

// 타입명 → 샘플 값 (요청 바디 자동 생성용)
function sampleForType(t) {
  const x = (t || '').replace(/[?<].*$/, '').toLowerCase();
  if (/(int|long|short|byte|double|float|number|decimal|integer)/.test(x)) return 1;
  if (/bool/.test(x)) return true;
  if (/(list|set|collection|array|iterable|seq)/.test(x)) return [];
  if (/map|object/.test(x)) return {};
  return 'sample';
}

// 소스에서 DTO(생성자 파라미터 기반: Kotlin data class / class, Java record) → {타입: {필드: 샘플}}
function extractDtos(text) {
  const dtos = {};
  const re = /\b(?:data\s+class|class|record)\s+([A-Z]\w*)\s*\(([^)]*)\)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const fields = {};
    for (const raw of splitParamsTopLevel(m[2])) {
      const p = raw.trim();
      if (!p) continue;
      let fm = p.match(/(?:val|var)\s+(\w+)\s*:\s*([A-Za-z_][\w<>.]*)/); // Kotlin
      if (fm) { fields[fm[1]] = sampleForType(fm[2]); continue; }
      const jm = p.match(/^(?:@\w+\s+)*([A-Za-z_][\w<>.]*)\s+(\w+)$/); // Java record: Type name
      if (jm) fields[jm[2]] = sampleForType(jm[1]);
    }
    if (Object.keys(fields).length) dtos[m[1]] = fields;
  }
  return dtos;
}

// FastAPI / Flask 스타일 — @router.get("/x") / @app.post("/x") (prefix 는 추정 불가하므로 무시)
function extractFastApiEndpoints(text) {
  const endpoints = [];
  const re = /@\s*(?:\w+)\.(get|post|put|delete|patch)\s*\(\s*["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    endpoints.push({ method: m[1].toUpperCase(), path: joinPath('', m[2]) });
  }
  return endpoints;
}

function extractEndpoints(text, ext) {
  if (ext === '.java' || ext === '.kt' || ext === '.kts') return extractSpringEndpoints(text);
  if (ext === '.py') return extractFastApiEndpoints(text);
  return [];
}

function generateK6Script(endpoints, baseUrl, name, dtoRegistry = {}) {
  let bodyHits = 0;
  const eps = endpoints.map((e) => {
    const p = (e.path.replace(/\{[^}]+\}/g, '1').replace(/:[a-zA-Z_]\w*/g, '1')) || '/';
    const hasBody = e.method === 'POST' || e.method === 'PUT' || e.method === 'PATCH';
    let body = null;
    if (hasBody) {
      if (e.bodyType && dtoRegistry[e.bodyType]) { body = JSON.stringify(dtoRegistry[e.bodyType]); bodyHits++; }
      else body = '{}';
    }
    return { method: e.method, path: p, body };
  });
  return { bodyHits, script: `import http from 'k6/http';
import { check, sleep } from 'k6';

// ⚛️ Quarkify auto-generated k6 load test — ${name}
// ⚠️ 경로 파라미터({id} 등)는 샘플값 '1'로 치환됨. POST/PUT/PATCH 바디는 파싱한 DTO 필드로 자동 생성(없으면 {}).
//    샘플 값은 타입별 기본값이니 실제 검증 값으로 조정하세요.
// 실행: k6 run loadtest.k6.js   |   BASE_URL=https://api.example.com VUS=50 DURATION=1m k6 run loadtest.k6.js

export const options = {
  vus: Number(__ENV.VUS || 10),
  duration: __ENV.DURATION || '30s',
  thresholds: {
    http_req_failed: ['rate<0.05'],
    http_req_duration: ['p(95)<800'],
  },
};

const BASE = __ENV.BASE_URL || ${JSON.stringify(baseUrl)};

const endpoints = ${JSON.stringify(eps, null, 2)};

export default function () {
  for (const ep of endpoints) {
    const url = BASE + ep.path;
    const params = { headers: { 'Content-Type': 'application/json' }, tags: { name: ep.method + ' ' + ep.path } };
    const res = http.request(ep.method, url, ep.body, params);
    check(res, { 'status < 500': (r) => r.status < 500 });
  }
  sleep(1);
}
` };
}

async function runK6() {
  if (!configPath) {
    console.error('사용법: node quarkify.mjs --k6 <config.mjs> [baseUrl]');
    process.exit(1);
  }
  if (!fs.existsSync(CONFIG.srcDir)) {
    console.error(`❌ 에러: srcDir 가 존재하지 않습니다: "${CONFIG.srcDir}"`);
    process.exit(1);
  }
  const baseUrl = process.argv[4] || 'http://localhost:8080';
  console.log(`🎯 k6 부하테스트 생성 — ${CONFIG.name} (base: ${baseUrl})`);

  const files = resolveSourceFiles({ verbose: false });
  const seen = new Set();
  const endpoints = [];
  const dtoRegistry = {};
  let scanned = 0;
  for (const rel of files) {
    const abs = path.join(CONFIG.srcDir, rel);
    if (!fs.existsSync(abs)) continue;
    scanned++;
    const text = fs.readFileSync(abs, 'utf-8');
    Object.assign(dtoRegistry, extractDtos(text)); // DTO 샘플 레지스트리 누적
    for (const ep of extractEndpoints(text, path.extname(abs))) {
      const key = `${ep.method} ${ep.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      endpoints.push(ep);
    }
  }

  if (endpoints.length === 0) {
    console.error(`❌ 엔드포인트를 찾지 못했습니다. (스캔 ${scanned}개 파일)`);
    console.error('Spring(@GetMapping 등) 또는 FastAPI(@router.get 등) 컨트롤러가 sourceFiles 에 포함됐는지 확인하세요.');
    process.exit(1);
  }

  const outDir = path.resolve(CONFIG.outDir);
  ensureDir(outDir);
  const outFile = path.join(outDir, 'loadtest.k6.js');
  const { script, bodyHits } = generateK6Script(endpoints, baseUrl, CONFIG.name, dtoRegistry);
  fs.writeFileSync(outFile, script, 'utf-8');

  console.log('=============================================');
  console.log(' 🎉 k6 부하테스트 생성 완료!');
  console.log('=============================================');
  console.log(` 🎯 엔드포인트:       ${endpoints.length}개`);
  console.log(` 📦 DTO 자동 바디:    ${bodyHits}개 (DTO ${Object.keys(dtoRegistry).length}종 인식)`);
  for (const ep of endpoints.slice(0, 12)) console.log(`    ${ep.method.padEnd(6)} ${ep.path}`);
  if (endpoints.length > 12) console.log(`    ... 외 ${endpoints.length - 12}개`);
  console.log(` 📄 스크립트:         ${outFile}`);
  console.log(` ▶️  실행:            k6 run "${outFile}"`);
  console.log('=============================================\n');
}

// ─── 문서 문장단위 분해/재조합 (Document sentence-level decompose / recompose) ───
// 코드와 달리 문서는 텍스트가 곧 내용이므로 *문장 텍스트를 보존*한다(무손실).
// AI 가 문장 단위 폴더를 원자적으로 읽고 경로로 정확히 참조 → 할루시네이션 억제.
// 재조합은 저장된 문장을 순서대로 그대로 잇는 것이라 날조가 불가능하다.
// (Unlike code, a document's text IS its content, so sentence text is preserved losslessly.)

const SENT_PAD = (n) => String(n).padStart(4, '0');

// 한국어/영어 문장 분리 (종결부호 . ! ? 。 … 기준; 한국어 '다.'/'요.' 는 . 로 커버)
function splitSentences(text) {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  if (!t) return [];
  const parts = t.match(/[^.!?。…\n]+[.!?。…]+|\S[^.!?。…\n]*$/g);
  return parts ? parts.map((s) => s.trim()).filter(Boolean) : [t];
}

// 문서를 블록(heading / paragraph) 목록으로 파싱 (Parse a doc into heading/paragraph blocks)
function parseDocBlocks(text) {
  const blocks = [];
  let cur = [];
  const flush = () => { if (cur.length) { blocks.push({ type: 'p', text: cur.join(' ') }); cur = []; } };
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    const hm = line.trim().match(/^(#{1,6})\s+(.*)$/);
    if (hm) {
      flush();
      blocks.push({ type: 'h', level: hm[1].length, text: hm[2].trim() });
    } else if (line.trim() === '') {
      flush();
    } else {
      cur.push(line.trim());
    }
  }
  flush();
  return blocks;
}

async function runDocDecompose() {
  const file = process.argv[3];
  if (!file) {
    console.error('사용법: node quarkify.mjs --doc <문서파일.md|txt> [outDir]');
    process.exit(1);
  }
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) {
    console.error(`❌ 에러: 문서 파일이 없습니다: ${resolved}`);
    process.exit(1);
  }
  const text = fs.readFileSync(resolved, 'utf-8');
  const baseName = path.basename(resolved);
  const outDir = process.argv[4] ? path.resolve(process.argv[4]) : path.join(path.dirname(resolved), 'doc_quark');
  mkdirSync(outDir);
  const docDir = path.join(outDir, `doc__${safeName(baseName)}`);
  if (fs.existsSync(docDir)) fs.rmSync(docDir, { recursive: true });
  mkdirSync(docDir);

  const blocks = parseDocBlocks(text);
  let blkIdx = 0, sentTotal = 0;
  for (const blk of blocks) {
    if (blk.type === 'h') {
      const bdir = path.join(docDir, `blk_${SENT_PAD(blkIdx++)}__h${blk.level}__${safeName(blk.text).substring(0, 40)}`);
      mkdirSync(bdir);
      fs.writeFileSync(path.join(bdir, '_text.txt'), blk.text, 'utf-8');
    } else {
      const bdir = path.join(docDir, `blk_${SENT_PAD(blkIdx++)}__p`);
      mkdirSync(bdir);
      let si = 0;
      for (const s of splitSentences(blk.text)) {
        const sdir = path.join(bdir, `sen_${SENT_PAD(si++)}__${safeName(s).substring(0, 40)}`);
        mkdirSync(sdir);
        fs.writeFileSync(path.join(sdir, '_text.txt'), s, 'utf-8');
        sentTotal++;
      }
    }
  }

  console.log('=============================================');
  console.log(' 🎉 문서 분해 완료!');
  console.log('=============================================');
  console.log(` 📄 문서:             ${baseName}`);
  console.log(` 🧱 블록:             ${blkIdx} (heading/paragraph)`);
  console.log(` ✂️  문장 폴더:       ${sentTotal}`);
  console.log(` 📁 경로:             ${docDir}`);
  console.log(` ↩️  재조합:          node quarkify.mjs --doc-join "${docDir}" <out.md>`);
  console.log('=============================================\n');
}

async function runDocJoin() {
  const target = process.argv[3];
  if (!target) {
    console.error('사용법: node quarkify.mjs --doc-join <doc__디렉터리> [out.md]');
    process.exit(1);
  }
  let docDir = path.resolve(target);
  if (!fs.existsSync(docDir)) {
    console.error(`❌ 에러: 디렉터리가 없습니다: ${docDir}`);
    process.exit(1);
  }
  // doc__ 디렉터리가 아니면 하위에서 찾는다 (accept parent dir too)
  if (!path.basename(docDir).startsWith('doc__')) {
    const sub = fs.readdirSync(docDir, { withFileTypes: true }).find((e) => e.isDirectory() && e.name.startsWith('doc__'));
    if (sub) docDir = path.join(docDir, sub.name);
  }

  const blocks = fs.readdirSync(docDir, { withFileTypes: true })
    .filter((e) => e.isDirectory()).map((e) => e.name).sort();
  let out = '';
  for (const b of blocks) {
    const bpath = path.join(docDir, b);
    const hm = b.match(/^blk_\d+__h(\d)/);
    if (hm) {
      const txt = fs.readFileSync(path.join(bpath, '_text.txt'), 'utf-8');
      out += '#'.repeat(Number(hm[1])) + ' ' + txt + '\n\n';
    } else {
      const sens = fs.readdirSync(bpath, { withFileTypes: true })
        .filter((e) => e.isDirectory()).map((e) => e.name).sort();
      const texts = sens.map((s) => fs.readFileSync(path.join(bpath, s, '_text.txt'), 'utf-8'));
      if (texts.length) out += texts.join(' ') + '\n\n';
    }
  }
  const outFile = process.argv[4] ? path.resolve(process.argv[4]) : path.join(path.dirname(docDir), 'rejoined.md');
  fs.writeFileSync(outFile, out.trimEnd() + '\n', 'utf-8');

  console.log('=============================================');
  console.log(' 🎉 문서 재조합 완료!');
  console.log('=============================================');
  console.log(` 🧱 블록:             ${blocks.length}`);
  console.log(` 📄 출력:             ${outFile}`);
  console.log('=============================================\n');
}

// ─── 분석: --stats (복잡도/규모 리포트), --diff (구조 변화) ───
const DECISION_RE = /__(?:if|elif|else|for|while|switch|try|catch|except|case)\b/;

function listQuarkSymbolDirs(quarkDir) {
  // fn/method/kernel/device_fn/host_fn 심볼 폴더를 (경로, 종류) 로 수집
  const out = [];
  const KINDS = ['fn', 'method', 'kernel', 'device_fn', 'host_fn'];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const full = path.join(dir, e.name);
      const k = e.name.split('__')[0];
      if (KINDS.includes(k)) out.push({ name: e.name, path: full });
      walk(full);
    }
  };
  walk(quarkDir);
  return out;
}

function countDecisions(dir) {
  let n = 0;
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (DECISION_RE.test(e.name)) n++;
      walk(path.join(d, e.name));
    }
  };
  walk(dir);
  return n;
}

async function runStats() {
  const target = process.argv[3];
  if (!target) { console.error('사용법: node quarkify.mjs --stats <outDir>'); process.exit(1); }
  const resolved = path.resolve(target);
  const quarkDir = fs.existsSync(path.join(resolved, 'quark')) ? path.join(resolved, 'quark') : resolved;
  if (!fs.existsSync(quarkDir)) { console.error(`❌ quark 디렉터리가 없습니다: ${quarkDir}`); process.exit(1); }

  // 메타데이터로 LOC 보강 (있으면)
  const metaPath = path.join(resolved, 'quark_meta.json');
  const locByQuark = {};
  if (fs.existsSync(metaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
      for (const s of meta.symbols || []) {
        if (s.startLine && s.endLine) locByQuark[s.quark] = (s.endLine - s.startLine + 1);
      }
    } catch {}
  }

  const fns = listQuarkSymbolDirs(quarkDir).map((f) => {
    const complexity = 1 + countDecisions(f.path);
    const rel = path.relative(quarkDir, f.path);
    return { name: f.name, rel, complexity, loc: locByQuark[rel] || null };
  });
  fns.sort((a, b) => b.complexity - a.complexity);

  const totalC = fns.reduce((s, f) => s + f.complexity, 0);
  const avgC = fns.length ? (totalC / fns.length) : 0;
  console.log('=============================================');
  console.log(' 📊 Quarkify 복잡도/규모 리포트');
  console.log('=============================================');
  console.log(` 함수/메서드:        ${fns.length}`);
  console.log(` 평균 복잡도:        ${avgC.toFixed(1)}`);
  console.log(` 최대 복잡도:        ${fns.length ? fns[0].complexity : 0}`);
  console.log('\n 🔥 복잡도 상위 (리팩토링 후보):');
  for (const f of fns.slice(0, 15)) {
    console.log(`   C=${String(f.complexity).padStart(3)} ${f.loc ? `(${f.loc}줄) ` : ''}${f.rel}`);
  }
  const outFile = path.join(resolved, 'quark_stats.json');
  fs.writeFileSync(outFile, JSON.stringify({ count: fns.length, avgComplexity: avgC, functions: fns }), 'utf-8');
  console.log(`\n 📄 상세: ${outFile}`);
  console.log('=============================================\n');
}

// 두 출력의 심볼 집합을 비교 (추가/삭제). 심볼 식별자는 quark 상대경로.
function symbolSetOf(outDir) {
  const resolved = path.resolve(outDir);
  const metaPath = path.join(resolved, 'quark_meta.json');
  if (fs.existsSync(metaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
      return new Set((meta.symbols || []).map((s) => `${s.kind}:${s.quark}`));
    } catch {}
  }
  // 폴백: quark 트리에서 심볼 폴더 수집
  const quarkDir = fs.existsSync(path.join(resolved, 'quark')) ? path.join(resolved, 'quark') : resolved;
  const set = new Set();
  for (const f of listQuarkSymbolDirs(quarkDir)) set.add(`x:${path.relative(quarkDir, f.path)}`);
  return set;
}

async function runDiff() {
  const a = process.argv[3], b = process.argv[4];
  if (!a || !b) { console.error('사용법: node quarkify.mjs --diff <oldOutDir> <newOutDir>'); process.exit(1); }
  const setA = symbolSetOf(a), setB = symbolSetOf(b);
  const added = [...setB].filter((s) => !setA.has(s));
  const removed = [...setA].filter((s) => !setB.has(s));
  console.log('=============================================');
  console.log(' 🔀 Quarkify 구조 변화 (diff)');
  console.log('=============================================');
  console.log(` old 심볼: ${setA.size}  →  new 심볼: ${setB.size}`);
  console.log(` ➕ 추가: ${added.length}   ➖ 삭제: ${removed.length}`);
  if (added.length) { console.log('\n ➕ 추가된 심볼:'); for (const s of added.slice(0, 30)) console.log(`   + ${s.replace(/^[^:]*:/, '')}`); }
  if (removed.length) { console.log('\n ➖ 삭제된 심볼:'); for (const s of removed.slice(0, 30)) console.log(`   - ${s.replace(/^[^:]*:/, '')}`); }
  if (!added.length && !removed.length) console.log('\n 변화 없음 (심볼 집합 동일).');
  console.log('=============================================\n');
}

// ─── OSS 난제 해결 도구 (--solve): 이슈 키워드 → 해결 컨텍스트 팩 ───
// 풀 자동수정은 외부 LLM 에이전트의 몫. 여기서는 그 "엔진" — 어디를 고쳐야 하는지(정확한 file:line)
// 와 영향 범위(호출자/피호출자)를 Quarkify 메타+콜그래프로 그라운딩해 최소 토큰 팩으로 만든다.

const STOPWORDS = new Set(['the', 'a', 'an', 'is', 'to', 'of', 'in', 'on', 'and', 'or', 'for', 'with',
  'error', 'issue', 'bug', 'fix', 'when', 'after', 'this', 'that', '버그', '에러', '문제', '오류', '하면', '에서', '관련']);

function tokenizeQuery(q) {
  const raw = (q || '').toLowerCase().split(/[^a-z0-9가-힣]+/).filter(Boolean);
  return [...new Set(raw.filter((t) => t.length >= 2 && !STOPWORDS.has(t)))];
}

// 심볼명을 단어로 분해 (camelCase / snake_case / Class__method)
function symbolWords(s) {
  return (s || '').replace(/__/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_.]/g, ' ').toLowerCase();
}

// resolves_to__ 역인덱스: 타겟토큰 → [호출자 심볼 quark]  (token = safeName(정의 quark).slice(0,90))
function buildCallerIndex(quarkDir) {
  const idx = Object.create(null);
  const KINDS = ['fn', 'method', 'kernel', 'device_fn', 'host_fn'];
  const walk = (dir, ownerRel) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const rel = path.relative(quarkDir, path.join(dir, e.name));
      const kind = e.name.split('__')[0];
      const owner = KINDS.includes(kind) ? rel : ownerRel;
      if (e.name.startsWith('resolves_to__') && ownerRel) {
        const token = e.name.slice('resolves_to__'.length);
        (idx[token] || (idx[token] = new Set())).add(ownerRel);
      }
      walk(path.join(dir, e.name), owner);
    }
  };
  walk(quarkDir, null);
  return idx;
}

async function runSolve() {
  const target = process.argv[3];
  const query = process.argv.slice(4).join(' ').trim();
  if (!target || !query) {
    console.error('사용법: node quarkify.mjs --solve <outDir> "<이슈 설명/키워드>"');
    process.exit(1);
  }
  const resolved = path.resolve(target);
  const metaPath = path.join(resolved, 'quark_meta.json');
  if (!fs.existsSync(metaPath)) {
    console.error(`❌ quark_meta.json 이 없습니다. 먼저 해당 레포를 quarkify 하세요: ${metaPath}`);
    process.exit(1);
  }
  const quarkDir = path.join(resolved, 'quark');
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
  const tokens = tokenizeQuery(query);
  if (!tokens.length) { console.error('❌ 유효한 키워드가 없습니다.'); process.exit(1); }

  // 관련도 점수: 이름(가중3) + 시그니처(2) + 파일경로(1) 에서 토큰 매칭
  const scored = [];
  for (const s of meta.symbols || []) {
    const nameW = symbolWords(s.name);
    const sigW = (s.signature || '').toLowerCase();
    const fileW = (s.file || '').toLowerCase();
    let score = 0;
    for (const t of tokens) {
      if (nameW.includes(t)) score += 3;
      if (sigW.includes(t)) score += 2;
      if (fileW.includes(t)) score += 1;
    }
    if (score > 0) scored.push({ ...s, score });
  }
  scored.sort((a, b) => b.score - a.score || (a.endLine - a.startLine) - (b.endLine - b.startLine));
  const top = scored.slice(0, 12);

  const callerIdx = fs.existsSync(quarkDir) ? buildCallerIndex(quarkDir) : {};
  const calleesOf = (quarkRel) => {
    const dir = path.join(quarkDir, quarkRel);
    const out = new Set();
    const walk = (d) => {
      let entries; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        if (e.name.startsWith('call__')) out.add(e.name.slice('call__'.length));
        else walk(path.join(d, e.name));
      }
    };
    walk(dir);
    return [...out];
  };

  // 컨텍스트 팩 작성
  let md = `# 🩺 Quarkify Solve Pack\n\n**이슈:** ${query}\n\n**키워드:** ${tokens.join(', ')}\n\n`;
  md += `상위 ${top.length}개 후보 (관련도 순). 각 항목의 file:line 만 열어 최소 토큰으로 수정하세요.\n\n`;
  if (!top.length) md += '_관련 심볼을 찾지 못했습니다. 키워드를 바꿔보세요._\n';
  const fileSet = new Set();
  for (const s of top) {
    fileSet.add(s.file);
    const callees = calleesOf(s.quark);
    const token = safeName(s.quark).substring(0, 90);
    const callers = callerIdx[token] ? [...callerIdx[token]] : [];
    md += `## ${s.name}  ·  점수 ${s.score}\n`;
    md += `- 위치: \`${s.file}:${s.startLine || '?'}${s.endLine ? '-' + s.endLine : ''}\`\n`;
    md += `- 종류/역할: ${s.kind} / ${s.role}\n`;
    if (s.signature) md += `- 시그니처: \`${s.signature}\`\n`;
    md += `- 영향(호출자 ${callers.length}): ${callers.slice(0, 6).map((c) => '`' + c.split('/').pop() + '`').join(', ') || '없음/미상'}\n`;
    md += `- 호출(피호출 ${callees.length}): ${callees.slice(0, 10).map((c) => '`' + c + '`').join(', ') || '없음'}\n\n`;
  }
  md += `## 📂 읽어볼 파일 (집중)\n${[...fileSet].map((f) => `- ${f}`).join('\n')}\n\n`;
  md += `## ▶️ 다음 단계 (외부 LLM 에이전트)\n1. 위 file:line 만 컨텍스트로 로드(전체 파일 X)\n2. 호출자 목록으로 변경 영향 검토\n3. 수정 후 \`--diff\` 로 구조 변화 확인, 테스트 실행\n`;

  const outFile = path.join(resolved, 'solve_pack.md');
  fs.writeFileSync(outFile, md, 'utf-8');
  const jsonFile = path.join(resolved, 'solve_pack.json');
  fs.writeFileSync(jsonFile, JSON.stringify({ query, tokens, candidates: top }), 'utf-8');

  console.log('=============================================');
  console.log(' 🩺 Solve Pack 생성 완료!');
  console.log('=============================================');
  console.log(` 🔑 키워드:           ${tokens.join(', ')}`);
  console.log(` 🎯 후보 심볼:        ${top.length} / 매칭 ${scored.length}`);
  for (const s of top.slice(0, 8)) console.log(`   [${s.score}] ${s.name}  ${s.file}:${s.startLine || '?'}`);
  console.log(` 📄 팩:               ${outFile}`);
  console.log('=============================================\n');
}

// ─── 데드코드 감지 (--dead): 호출자가 없는(끊긴 선) 심볼 후보 ───
// ⚠️ 휴리스틱: 동적 디스패치/프레임워크 호출(@Bean, 이벤트 핸들러, 라이브러리 export, 오버라이드)은
//    호출자가 코드상 안 보여 오탐될 수 있다. 진입점(web_endpoint)·main/init 류는 제외한다.
const ENTRY_NAME_RE = /^(main|init|__init__|__main__|setup|configure|register|bootstrap|run|handle|start|index|App)$/i;

async function runDead() {
  const target = process.argv[3];
  if (!target) { console.error('사용법: node quarkify.mjs --dead <outDir>'); process.exit(1); }
  const resolved = path.resolve(target);
  const metaPath = path.join(resolved, 'quark_meta.json');
  if (!fs.existsSync(metaPath)) {
    console.error(`❌ quark_meta.json 이 없습니다. 먼저 quarkify 하세요: ${metaPath}`);
    process.exit(1);
  }
  const quarkDir = path.join(resolved, 'quark');
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
  const callerIdx = fs.existsSync(quarkDir) ? buildCallerIndex(quarkDir) : {};
  const CALLABLE = new Set(['fn', 'method', 'kernel', 'device_fn', 'host_fn']);

  // 심볼 quark 폴더에 annotation__ 자식이 있으면 프레임워크가 호출(@GetMapping/@Bean/@ExceptionHandler 등) → 데드 아님
  const isAnnotated = (quarkRel) => {
    const dir = path.join(quarkDir, quarkRel);
    try {
      return fs.readdirSync(dir, { withFileTypes: true })
        .some((e) => e.isDirectory() && e.name.startsWith('annotation__'));
    } catch { return false; }
  };

  const dead = [];
  let callableTotal = 0, annotatedSkipped = 0;
  for (const s of meta.symbols || []) {
    if (!CALLABLE.has(s.kind)) continue;
    callableTotal++;
    if (s.role === 'web_endpoint') continue;        // HTTP 진입점은 외부에서 호출됨
    if (ENTRY_NAME_RE.test(s.name)) continue;        // main/init 류 진입점
    if (isAnnotated(s.quark)) { annotatedSkipped++; continue; } // 프레임워크 호출
    const token = safeName(s.quark).substring(0, 90);
    const callers = callerIdx[token];
    if (!callers || callers.size === 0) dead.push(s);
  }
  dead.sort((a, b) => (b.endLine - b.startLine) - (a.endLine - a.startLine));

  console.log('=============================================');
  console.log(' 🪦 데드코드 후보 (호출자 없음 = 끊긴 선)');
  console.log('=============================================');
  console.log(` 함수/메서드 총 ${callableTotal} · 어노테이션(프레임워크) 제외 ${annotatedSkipped} · 데드 후보 ${dead.length}`);
  console.log(' ⚠️ 휴리스틱 — 동적 호출/라이브러리 export/인터페이스 구현은 오탐 가능. 삭제 전 확인.');
  for (const s of dead.slice(0, 25)) {
    const loc = `${s.file}:${s.startLine || '?'}`;
    const lines = (s.endLine && s.startLine) ? `${s.endLine - s.startLine + 1}줄` : '';
    console.log(`   ✂️ ${s.name}  ${loc} ${lines}`);
  }
  if (dead.length > 25) console.log(`   ... 외 ${dead.length - 25}개`);
  const outFile = path.join(resolved, 'dead_code.json');
  fs.writeFileSync(outFile, JSON.stringify({ callableTotal, count: dead.length, candidates: dead }), 'utf-8');
  console.log(` 📄 ${outFile}`);
  console.log('=============================================\n');
}

// ─── 진입점 분기 (Entry-point dispatch) ───
if (!isMainThread) {
  runWorker().catch((err) => {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  });
} else if (DEAD_MODE) {
  runDead().catch((err) => { console.error(err && err.message ? err.message : err); process.exit(1); });
} else if (SOLVE_MODE) {
  runSolve().catch((err) => { console.error(err && err.message ? err.message : err); process.exit(1); });
} else if (STATS_MODE) {
  runStats().catch((err) => { console.error(err && err.message ? err.message : err); process.exit(1); });
} else if (DIFF_MODE) {
  runDiff().catch((err) => { console.error(err && err.message ? err.message : err); process.exit(1); });
} else if (DOC_MODE) {
  const docFn = process.argv[2] === '--doc' ? runDocDecompose : runDocJoin;
  docFn().catch((err) => {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  });
} else if (K6_MODE) {
  runK6().catch((err) => {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  });
} else if (REVERSE_MODE) {
  const reverse = process.argv[2] === '--collapse' ? runCollapse : runExpand;
  reverse().catch((err) => {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  });
} else {
  main().catch((err) => {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  });
}
