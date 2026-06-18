# Quarkify — 작업 지침 (Project Guidelines)

## 핵심 원칙 ⚠️
**문제가 생기면 Quarkify 자체를 고도화해서 흡수한다. 소비하는 프로젝트(lemony, OSS 자동수정기 등)나 분석 대상 프로젝트를 바꿔서 우회하지 않는다.**
Quarkify는 토대/엔진이다. 견고함·지능은 여기 들어가야 모든 소비자가 혜택을 보고, 위에서 땜질할 필요가 없어진다.
예: 소비자가 잘못된 글로브를 넘겨 Quarkify가 "매칭 0"으로 죽었다면 → 옳은 수정은 **Quarkify의 언어 자동감지 + 무매칭 폴백**이지, 소비자의 글로브 로직 패치가 아니다.

## Quarkify가 무엇인가
소스코드를 **물리적 폴더 토폴로지**로 분해하는 정적 분석 엔진. "everything is a folder."
- 함수 1개 → 폴더 1개, 구문 1개 → 하위 폴더, PTX opcode 1개 → 최하위 폴더. 폴더명 = 데이터.
- AI가 파일을 **읽지 않고** `ls`/`tree`/`fd`/`rg` 한 번으로 구조를 인식 → 토큰 대폭 절감, 할루시네이션 거의 제거(폴더는 실재라 지어낼 수 없음).
- grep으로는 못 하는 것(집계/시계열/조인)을 폴더 구조 + 파생 레이어로 가능케 한다.

## 불변 원칙 (바꾸지 말 것)
- **이뮤터블 / 셀프힐링** 방법론 자체는 유지한다.
- forward 변환은 lossy(safeName) — 원본 소스 복원 불가. collapse/expand 는 폴더↔JSON 무손실 왕복만 보장.
- 출력은 결정적(병렬=순차 동일).

## 구현된 기능 (요약)
파서: TS/JS·Python·Kotlin·Java·Go·Rust·Swift·C#·Zig·CUDA·C/C++·Metal·PTX.
모드: 기본 quarkify, `--collapse`/`--expand`, `--k6`, `--doc`/`--doc-join`, `--stats`, `--diff`, `--solve`.
부가: 콜그래프(`resolves_to__`), `quark_meta.json`(file:line), 증분 빌드, 2D/3D 뷰어, 워커 병렬화.

## 로드맵 (브레인덤프 기반)
- **데드코드 감지**: 콜그래프에서 들어오는 엣지 없고 진입점도 아닌 심볼 = 끊긴 선 = 데드코드.
- **perf 집계/시계열/조인**: hotpath 총 시간점유 1위 커널, 커밋별 속도 향상(ledger=시계열), 죽은 커널, ptxas 레지스터 실측.
- **보안 스캔 통합**(Trivy/Chainguard)을 폴더 토폴로지에 매핑.
- **4D 시각화**(시간축=ledger), 폴더 간 점/선 그래프.

## 커밋 규칙
이 repo 커밋엔 Claude/Co-Authored-By 어트리뷰션을 넣지 않는다. (remote `shb` = github.com/lemon0333/Quarkify_SHB_version)
