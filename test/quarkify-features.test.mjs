import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(repoRoot, 'quarkify.mjs');

async function withTempWorkspace(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'quarkify-feat-'));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

function runCli(args) {
  return spawnSync(process.execPath, [cliPath, ...args], { cwd: repoRoot, encoding: 'utf8' });
}

// srcFiles: { 'rel/path': 'content' }. 반환: { outDir, result }
async function quarkifyProject(tmp, srcFiles, sourceFiles) {
  const srcDir = path.join(tmp, 'src');
  const outDir = path.join(tmp, 'out');
  for (const [rel, content] of Object.entries(srcFiles)) {
    const abs = path.join(srcDir, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf8');
  }
  const configPath = path.join(tmp, 'config.mjs');
  await writeFile(configPath, `export default {
    name: 'feat-test',
    srcDir: ${JSON.stringify(srcDir)},
    outDir: ${JSON.stringify(outDir)},
    sourceFiles: ${JSON.stringify(sourceFiles)},
    perfData: {},
    guessRole(n){ const x=n.toLowerCase(); if(x.includes('controller'))return 'web_endpoint'; return 'general'; },
  };\n`, 'utf8');
  const result = runCli([configPath]);
  return { outDir, srcDir, configPath, result };
}

function dirsOf(root) {
  // root 하위 모든 디렉터리 상대경로 (정렬)
  const out = [];
  const walk = (d, base) => {
    for (const e of require_readdir(d)) {
      if (e.isDirectory()) { const rel = path.join(base, e.name); out.push(rel); walk(path.join(d, e.name), rel); }
    }
  };
  walk(root, '');
  return out.sort();
}
function require_readdir(d) { try { return readdirSync(d, { withFileTypes: true }); } catch { return []; } }

test('Kotlin: class/data class/fn/주생성자 필드/어노테이션 분해', async () => {
  await withTempWorkspace(async (tmp) => {
    const kt = `package x
@RestController
class FooController(private val svc: BarService) {
    @GetMapping("/x")
    fun list(): String { return svc.all() }
}
data class Dto(val a: Int, val b: String)
`;
    const { outDir, result } = await quarkifyProject(tmp, { 'Foo.kt': kt }, ['Foo.kt']);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const base = path.join(outDir, 'quark', 'file__Foo.kt');
    assert.ok(existsSync(path.join(base, 'class__FooController')), 'class__FooController');
    assert.ok(existsSync(path.join(base, 'class__FooController', 'fn__list')), 'fn__list');
    assert.ok(existsSync(path.join(base, 'class__FooController', 'field__svc')), 'field__svc (주생성자)');
    assert.ok(existsSync(path.join(base, 'class__FooController', 'annotation__RestController')), 'annotation__RestController');
    assert.ok(existsSync(path.join(base, 'class__Dto', 'field__a')), 'data class field__a');
    assert.ok(existsSync(path.join(base, 'class__Dto', 'field__b')), 'data class field__b');
  });
});

test('Go/Rust: 다언어 심볼 분해', async () => {
  await withTempWorkspace(async (tmp) => {
    const go = `package main
type User struct { Name string }
func Greet() string { return helper() }
func helper() string { return "" }
`;
    const rs = `pub struct Point { pub x: i32 }
pub enum Color { Red }
pub fn add(a: i32, b: i32) -> i32 { a + b }
`;
    const { outDir, result } = await quarkifyProject(tmp, { 'main.go': go, 'lib.rs': rs }, ['main.go', 'lib.rs']);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const goBase = path.join(outDir, 'quark', 'file__main.go');
    assert.ok(existsSync(path.join(goBase, 'struct__User')), 'go struct__User');
    assert.ok(existsSync(path.join(goBase, 'fn__Greet')), 'go fn__Greet');
    const rsBase = path.join(outDir, 'quark', 'file__lib.rs');
    assert.ok(existsSync(path.join(rsBase, 'struct__Point')), 'rust struct__Point');
    assert.ok(existsSync(path.join(rsBase, 'enum__Color')), 'rust enum__Color');
    assert.ok(existsSync(path.join(rsBase, 'fn__add')), 'rust fn__add');
  });
});

test('quark_meta.json: 심볼 메타데이터 + 숫자 startLine', async () => {
  await withTempWorkspace(async (tmp) => {
    const { outDir } = await quarkifyProject(tmp, { 'a.kt': 'class A {\n  fun foo() {}\n}\n' }, ['a.kt']);
    const metaPath = path.join(outDir, 'quark_meta.json');
    assert.ok(existsSync(metaPath), 'quark_meta.json 존재');
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    assert.ok(Array.isArray(meta.symbols) && meta.symbols.length > 0, 'symbols 비어있지 않음');
    assert.ok(meta.symbols.some((s) => typeof s.startLine === 'number'), 'startLine 숫자 존재');
  });
});

test('콜그래프: call__X → resolves_to__ 연결', async () => {
  await withTempWorkspace(async (tmp) => {
    const go = `package main
func Greet() string { return helper() }
func helper() string { return "" }
`;
    const { outDir } = await quarkifyProject(tmp, { 'main.go': go }, ['main.go']);
    let found = false;
    const walk = (d) => { for (const e of require_readdir(d)) { if (e.isDirectory()) { if (e.name.startsWith('resolves_to__')) found = true; walk(path.join(d, e.name)); } } };
    walk(path.join(outDir, 'quark'));
    assert.ok(found, 'resolves_to__ 폴더가 하나 이상 있어야 함');
  });
});

test('--collapse / --expand 무손실 왕복', async () => {
  await withTempWorkspace(async (tmp) => {
    const { outDir } = await quarkifyProject(tmp, { 'a.kt': 'class A {\n  fun foo() {}\n}\n' }, ['a.kt']);
    const col = runCli(['--collapse', outDir]);
    assert.equal(col.status, 0, col.stderr);
    const treeJson = path.join(outDir, 'quark_tree.json');
    assert.ok(existsSync(treeJson), 'quark_tree.json 생성');
    const restored = path.join(tmp, 'restored');
    const exp = runCli(['--expand', treeJson, restored]);
    assert.equal(exp.status, 0, exp.stderr);
    const orig = dirsOf(path.join(outDir, 'quark'));
    const back = dirsOf(path.join(restored, 'quark'));
    assert.deepEqual(back, orig, '복원 구조가 원본 quark 트리와 동일');
  });
});

test('--doc / --doc-join: 문장 폴더 + 텍스트 보존', async () => {
  await withTempWorkspace(async (tmp) => {
    const docFile = path.join(tmp, 'doc.md');
    await writeFile(docFile, '# 제목\n\n첫 문장이다. 둘째 문장이다.\n', 'utf8');
    const outDir = path.join(tmp, 'docout');
    const dec = runCli(['--doc', docFile, outDir]);
    assert.equal(dec.status, 0, dec.stderr);
    const docDir = path.join(outDir, 'doc__doc.md');
    assert.ok(existsSync(docDir), 'doc__ 디렉터리 생성');
    let textFiles = 0;
    const walk = (d) => { for (const e of require_readdir(d)) { if (e.isDirectory()) walk(path.join(d, e.name)); else if (e.name === '_text.txt') textFiles++; } };
    walk(docDir);
    assert.ok(textFiles >= 3, '_text.txt(헤딩+문장) 최소 3개');
    const rejoined = path.join(tmp, 'rejoined.md');
    const join = runCli(['--doc-join', docDir, rejoined]);
    assert.equal(join.status, 0, join.stderr);
    const out = readFileSync(rejoined, 'utf8');
    assert.ok(out.includes('첫 문장이다.') && out.includes('둘째 문장이다.'), '문장 텍스트 보존');
  });
});

test('--k6: 소스에서 Spring 엔드포인트 추출해 스크립트 생성', async () => {
  await withTempWorkspace(async (tmp) => {
    const kt = `@RestController
@RequestMapping("/api")
class C(private val s: S) {
  @GetMapping("/x") fun x(): String { return "" }
}
`;
    const { configPath, outDir } = await quarkifyProject(tmp, { 'C.kt': kt }, ['C.kt']);
    const k6 = runCli(['--k6', configPath, 'http://localhost:9999']);
    assert.equal(k6.status, 0, k6.stderr || k6.stdout);
    const script = path.join(outDir, 'loadtest.k6.js');
    assert.ok(existsSync(script), 'loadtest.k6.js 생성');
    const content = readFileSync(script, 'utf8');
    assert.ok(content.includes('/api/x'), '결합 경로 /api/x 포함');
    assert.ok(content.includes('http.request'), 'http.request 포함');
  });
});

test('증분 빌드: 무변경 재실행은 동일, 변경분만 갱신', async () => {
  await withTempWorkspace(async (tmp) => {
    const srcDir = path.join(tmp, 'src');
    const outDir = path.join(tmp, 'out');
    await mkdir(srcDir, { recursive: true });
    await writeFile(path.join(srcDir, 'A.kt'), 'class A {\n  fun a() {}\n}\n', 'utf8');
    await writeFile(path.join(srcDir, 'B.kt'), 'class B {\n  fun b() {}\n}\n', 'utf8');
    const configPath = path.join(tmp, 'config.mjs');
    await writeFile(configPath, `export default { name:'inc', srcDir:${JSON.stringify(srcDir)}, outDir:${JSON.stringify(outDir)}, sourceFiles:['*.kt'], perfData:{}, incremental:true, guessRole:()=>'general' };\n`, 'utf8');

    assert.equal(runCli([configPath]).status, 0, '1차 빌드');
    const after1 = dirsOf(path.join(outDir, 'quark'));
    assert.ok(existsSync(path.join(tmp, 'out', '.quarkify-cache.json')), '캐시 생성');

    const r2 = runCli([configPath]);
    assert.equal(r2.status, 0, '2차(무변경) 빌드');
    assert.ok(/변경없음 2/.test(r2.stdout), '무변경 2개 인식');
    assert.deepEqual(dirsOf(path.join(outDir, 'quark')), after1, '무변경 시 구조 동일');

    await writeFile(path.join(srcDir, 'B.kt'), 'class B {\n  fun b() {}\n  fun bb() {}\n}\n', 'utf8');
    const r3 = runCli([configPath]);
    assert.equal(r3.status, 0, '3차(변경) 빌드');
    assert.ok(/변경\/신규 1/.test(r3.stdout), '변경 1개만 재처리');
    assert.ok(existsSync(path.join(outDir, 'quark', 'file__B.kt', 'class__B', 'fn__bb')), '변경분 fn__bb 반영');
  });
});

test('--solve: 이슈 키워드로 관련 심볼 컨텍스트 팩 생성', async () => {
  await withTempWorkspace(async (tmp) => {
    const kt = `class AuthService {
  fun refreshToken(): String { return "" }
  fun unrelatedThing(): Int { return 0 }
}
`;
    const { outDir } = await quarkifyProject(tmp, { 'A.kt': kt }, ['A.kt']);
    const solve = runCli(['--solve', outDir, 'refresh token 인증']);
    assert.equal(solve.status, 0, solve.stderr || solve.stdout);
    const pack = path.join(outDir, 'solve_pack.md');
    assert.ok(existsSync(pack), 'solve_pack.md 생성');
    const content = readFileSync(pack, 'utf8');
    assert.ok(content.includes('refreshToken'), '관련 심볼 refreshToken 포함');
    assert.ok(existsSync(path.join(outDir, 'solve_pack.json')), 'solve_pack.json 생성');
  });
});

test('TS 객체 const 는 내부 세미콜론에서 끊기지 않고 전체 범위를 잡는다', async () => {
  await withTempWorkspace(async (tmp) => {
    const ts = `export const logger = {
  info: (m) => {
    if (true) {
      return;
    }
    console.log(m);
  },
  fatal: (m) => {
    console.log(m);
  },
};
`;
    const { outDir } = await quarkifyProject(tmp, { 'm.ts': ts }, ['m.ts']);
    const meta = JSON.parse(readFileSync(path.join(outDir, 'quark_meta.json'), 'utf8'));
    const logger = meta.symbols.find((s) => s.name === 'logger' && s.kind === 'var');
    assert.ok(logger, 'logger 객체 const 가 var 심볼로 잡힘');
    assert.ok(logger.endLine >= 11, `endLine 이 객체 끝(>=11)까지 — 내부 return; 에서 안 끊김 (got ${logger.endLine})`);
  });
});

test('--perf: ledger 시계열 + hotpath 집계', async () => {
  await withTempWorkspace(async (tmp) => {
    const srcDir = path.join(tmp, 'src');
    const outDir = path.join(tmp, 'out');
    await mkdir(srcDir, { recursive: true });
    await writeFile(path.join(srcDir, 'k.cu'),
      '__global__ void gemm(float* a) { int i = 0; }\n__global__ void softmax(float* x) { int j = 0; }\n', 'utf8');
    const cfg = path.join(tmp, 'cfg.mjs');
    const mk = (gemmDur) => writeFile(cfg, `export default { name:'perf', srcDir:${JSON.stringify(srcDir)}, outDir:${JSON.stringify(outDir)}, sourceFiles:['k.cu'], perfData:{ gemm:{duration_ms:${gemmDur},registers:64,dram_pct:72}, softmax:{duration_ms:20,registers:32,dram_pct:40} }, guessRole:()=>'general' };\n`, 'utf8');

    await mk(80); assert.equal(runCli([cfg]).status, 0, '1차');
    await mk(60); assert.equal(runCli([cfg]).status, 0, '2차');

    const ledger = readFileSync(path.join(outDir, '_ledger', 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean);
    assert.equal(ledger.length, 2, 'ledger 2 run 누적(시계열)');

    const perf = runCli(['--perf', outDir]);
    assert.equal(perf.status, 0, perf.stderr || perf.stdout);
    const report = JSON.parse(readFileSync(path.join(outDir, 'perf_report.json'), 'utf8'));
    assert.equal(report.hotpath[0].name, 'gemm', 'hotpath 1위 = gemm(80→60, 더 큰 metric)');
    assert.ok(/25\.0%/.test(perf.stdout), 'run 간 속도변화(↓25%) 출력');
    assert.ok(existsSync(path.join(outDir, 'index_4d.html')), '4D 뷰어(시간축) 생성');
  });
});

test('--dead: 호출자 없는 심볼을 데드코드 후보로', async () => {
  await withTempWorkspace(async (tmp) => {
    // Greet 는 아무도 호출 안 함(데드 후보), helper 는 Greet 가 호출함(데드 아님)
    const go = `package main
func Greet() string { return helper() }
func helper() string { return "" }
`;
    const { outDir } = await quarkifyProject(tmp, { 'main.go': go }, ['main.go']);
    const dead = runCli(['--dead', outDir]);
    assert.equal(dead.status, 0, dead.stderr || dead.stdout);
    const pack = JSON.parse(readFileSync(path.join(outDir, 'dead_code.json'), 'utf8'));
    const names = pack.candidates.map((c) => c.name);
    assert.ok(names.includes('Greet'), 'Greet(미호출)는 데드 후보');
    assert.ok(!names.includes('helper'), 'helper(호출됨)는 데드 아님');
  });
});

test('--stats / --diff 동작', async () => {
  await withTempWorkspace(async (tmp) => {
    const { outDir } = await quarkifyProject(tmp, { 'a.kt': 'class A {\n  fun foo() { if (true) {} }\n}\n' }, ['a.kt']);
    const stats = runCli(['--stats', outDir]);
    assert.equal(stats.status, 0, stats.stderr);
    assert.ok(existsSync(path.join(outDir, 'quark_stats.json')), 'quark_stats.json 생성');
    const diff = runCli(['--diff', outDir, outDir]);
    assert.equal(diff.status, 0, diff.stderr);
    assert.ok(/변화 없음|추가: 0/.test(diff.stdout), '자기 자신 diff = 변화 없음');
  });
});
