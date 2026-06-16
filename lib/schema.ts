// 표준 스키마 · 타입 · 모든 산수(합산/순액/증감/무결성/그룹핑).
// 서버(/api/parse)는 추출만, 산수는 전부 여기(클라이언트)에서 한다.

export type ItemStatus = "ok" | "exception" | "review";
export type DocType =
  | "income_statement"
  | "manufacturing_cost"
  | "balance_sheet"
  | "unknown";
export type Unit = "원" | "천원" | "백만원" | "unknown";

export interface Fiscal {
  current: string | null;
  prior: string | null;
}

// ── 비용 합산표(손익/제조원가) 한 품목 ─────────────────────────
export interface CostItem {
  name: string;
  pl: number | null; // 손익계산서 값
  cogm: number | null; // 제조원가명세서 값
  total: number | null; // pl + cogm
  status: ItemStatus;
  note: string;
}

// ── 재무상태표 유형자산 한 줄(모델 추출 원본) ─────────────────
export interface TangibleRaw {
  name: string;
  cost: { cur: number | null; pri: number | null };
  acc_dep: { cur: number | null; pri: number | null } | null; // no_dep이면 null
  no_dep: boolean;
  status: ItemStatus;
  note: string;
}

// ── /api/parse 가 이미지 1장당 반환하는 결과 ──────────────────
export interface ParsedDoc {
  doc_type: DocType;
  company_raw: string;
  company_key: string;
  fiscal: Fiscal;
  unit: Unit;
  // 비용 문서일 때
  items: CostItem[] | null;
  extras: { 손익계산서_판관비: number | null; 영업이익: number | null } | null;
  // 재무상태표일 때
  tangible_assets: TangibleRaw[] | null;
  printed_total: { cur: number | null; pri: number | null } | null;
  // PATCH 3: 소계 검산(모델 자가검증) 결과 — 행 밀림/드리프트 감지
  recapture: boolean; // 소계가 안 맞아 재촬영 권장
  recaptureReasons: string[]; // 사람이 읽을 사유
}

// 표준 비용 품목 16개 (출력 순서 고정)
export const STANDARD_ITEMS: string[] = [
  "원재료비",
  "연료비",
  "전력비",
  "용수비(수도비)",
  "외주가공비(위탁생산비)",
  "수선비(수리유지비)",
  "급여총액",
  "퇴직급여",
  "복리후생비",
  "임차료",
  "세금과공과",
  "감가상각비",
  "대손상각비",
  "경상연구개발비",
  "광고선전비",
  "운반·하역·보관비",
];

export const DOC_LABEL: Record<DocType, string> = {
  income_statement: "손익계산서",
  manufacturing_cost: "제조원가명세서",
  balance_sheet: "재무상태표",
  unknown: "미분류",
};

// ───────────────────────── 산수 유틸 ─────────────────────────

export function computeTotal(
  pl: number | null,
  cogm: number | null
): number | null {
  if (pl == null && cogm == null) return null;
  return (pl ?? 0) + (cogm ?? 0);
}

export function diff(cur: number | null, pri: number | null): number | null {
  if (cur == null || pri == null) return null;
  return cur - pri;
}

// 회사명 정규화 → 그룹핑 키 (모델값을 신뢰하지 않고 클라이언트에서 한 번 더).
// 눈에는 같아 보여도 코드가 다른 표기들을 모두 통일한다:
//  - NFKC: 조합형/완성형 한글(NFC/NFD), 전각/반각, ㈜→(주) 등을 한 형태로 정규화
//  - 법인격 표기((주)·㈜·주식회사 등)는 키에서 제거(표시는 원문 company_raw 사용)
//  - 코드 prefix, 공백, 괄호·점·가운뎃점 등 부수 문자 제거
export function normalizeCompanyKey(raw: string | null | undefined): string {
  if (!raw) return "";
  let s = String(raw).normalize("NFKC");
  s = s.replace(/회\s*사\s*(명|상호)?\s*[:：]/g, ""); // "회사명:" 라벨 제거
  s = s.replace(/\s+/g, ""); // 공백 전부 제거(자간 벌어짐 대응)
  s = s.replace(/^\d+[.\-_]/, ""); // 앞쪽 코드 prefix( 1000. ) 제거
  s = s.replace(/주식회사|유한회사|유한책임회사|합자회사|합명회사/g, ""); // 법인격(문어)
  s = s.replace(/\((주|유|재|사|합|자|有|株)\)/g, ""); // 법인격(괄호)
  // 남은 부수 문자 제거 — 한글(완성형+호환자모)/영문/숫자만 남긴다
  s = s.replace(/[^0-9A-Za-z가-힣㄰-㆏]/g, "");
  return s;
}

function toNum(v: any): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    let c = v.replace(/,/g, "").trim();
    if (c === "" || c === "-" || c === "–") return null;
    // 괄호/△ 음수
    let neg = false;
    if (/^\(.*\)$/.test(c)) {
      neg = true;
      c = c.slice(1, -1);
    }
    if (/^[△▲-]/.test(c)) {
      neg = true;
      c = c.replace(/^[△▲-]/, "");
    }
    c = c.replace(/[^0-9.]/g, "");
    if (c === "") return null;
    const n = Number(c);
    if (!Number.isFinite(n)) return null;
    return neg ? -n : n;
  }
  return null;
}

function toStatus(v: any): ItemStatus {
  return v === "ok" || v === "exception" || v === "review" ? v : "review";
}

function toUnit(v: any): Unit {
  return v === "원" || v === "천원" || v === "백만원" ? v : "unknown";
}

// ───────────────────────── 응답 정규화 ─────────────────────────

export function normalizeDoc(raw: any): ParsedDoc {
  // PATCH 1: 추출값은 항상 '원 단위 원본'으로 보관(반올림 금지).
  // 반올림은 표기 단계에서 최종값에만 1회 적용한다(클라이언트 표기 포매터).
  const M = (v: any): number | null => toNum(v);

  const doc_type: DocType =
    raw?.doc_type === "income_statement" ||
    raw?.doc_type === "manufacturing_cost" ||
    raw?.doc_type === "balance_sheet"
      ? raw.doc_type
      : "unknown";

  const company_raw =
    typeof raw?.company_raw === "string" ? raw.company_raw : "";
  const company_key =
    normalizeCompanyKey(raw?.company_key) || normalizeCompanyKey(company_raw);

  const fiscal: Fiscal = {
    current:
      typeof raw?.fiscal?.current === "string" ? raw.fiscal.current : null,
    prior: typeof raw?.fiscal?.prior === "string" ? raw.fiscal.prior : null,
  };

  let items: CostItem[] | null = null;
  let extras: ParsedDoc["extras"] = null;
  if (doc_type === "income_statement" || doc_type === "manufacturing_cost") {
    const byName = new Map<string, any>();
    if (Array.isArray(raw?.items)) {
      for (const it of raw.items)
        if (it && typeof it.name === "string") byName.set(it.name.trim(), it);
    }
    items = STANDARD_ITEMS.map((name) => {
      const src = byName.get(name);
      const pl = M(src?.pl);
      const cogm = M(src?.cogm);
      return {
        name,
        pl,
        cogm,
        total: computeTotal(pl, cogm),
        status: src ? toStatus(src.status) : "review",
        note: typeof src?.note === "string" ? src.note : "",
      };
    });
    extras = {
      손익계산서_판관비: M(raw?.extras?.["손익계산서_판관비"]),
      영업이익: M(raw?.extras?.["영업이익"]),
    };
  }

  let tangible_assets: TangibleRaw[] | null = null;
  let printed_total: ParsedDoc["printed_total"] = null;
  if (doc_type === "balance_sheet") {
    const arr = Array.isArray(raw?.tangible_assets) ? raw.tangible_assets : [];
    tangible_assets = arr
      .filter((t: any) => t && typeof t.name === "string")
      .map((t: any): TangibleRaw => {
        const no_dep = !!t.no_dep || t.acc_dep == null;
        return {
          name: t.name.trim(),
          cost: { cur: M(t?.cost?.cur), pri: M(t?.cost?.pri) },
          acc_dep: no_dep
            ? null
            : { cur: M(t?.acc_dep?.cur), pri: M(t?.acc_dep?.pri) },
          no_dep,
          status: toStatus(t.status),
          note: typeof t.note === "string" ? t.note : "",
        };
      });
    printed_total = {
      cur: M(raw?.printed_total?.cur),
      pri: M(raw?.printed_total?.pri),
    };
  }

  const recaptureReasons = Array.isArray(raw?.recapture_reasons)
    ? raw.recapture_reasons.filter((s: any) => typeof s === "string")
    : [];
  const recapture = !!raw?.recapture || recaptureReasons.length > 0;

  return {
    doc_type,
    company_raw,
    company_key,
    fiscal,
    unit: toUnit(raw?.unit),
    items,
    extras,
    tangible_assets,
    printed_total,
    recapture,
    recaptureReasons,
  };
}

// ───────── 클라이언트 뷰 모델 (그룹핑 + 계산 결과) ─────────

export interface CostView {
  items: CostItem[];
  extras: { 손익계산서_판관비: number | null; 영업이익: number | null };
}

export interface TangibleItem {
  name: string;
  cost: { cur: number | null; pri: number | null; delta: number | null };
  acc_dep: {
    cur: number | null;
    pri: number | null;
    delta: number | null;
  } | null;
  net: { cur: number | null; pri: number | null };
  no_dep: boolean;
  status: ItemStatus;
  note: string;
  // 할인율(%) 10~90, null=없음(100% 인정) — 당기/전기 각각 별도 적용
  // 취득원가(cost) 할인
  costDiscountPctCur: number | null;
  costDiscountPctPri: number | null;
  // 감가상각누계액(acc_dep) 할인
  depDiscountPctCur: number | null;
  depDiscountPctPri: number | null;
}

export interface TangibleTotals {
  net: { cur: number | null; pri: number | null };
  printed: { cur: number | null; pri: number | null };
  integrity: { cur: boolean; pri: boolean };
  applied: { cur: number | null; pri: number | null }; // 적용가 합계(당/전) = Σ 적용가
  // 항목 그룹별 '적용가' 소계 (당기/전기) — 할인율 반영(없음=순액)
  subtotalMachine: { cur: number | null; pri: number | null }; // 기계+시설+금형
  subtotalTools: { cur: number | null; pri: number | null }; // 공구와기구+비품
}

// 선택 가능한 할인율(%) — 없음(null) + 10~90
export const DISCOUNT_OPTIONS: (number | null)[] = [
  null,
  10,
  20,
  30,
  40,
  50,
  60,
  70,
  80,
  90,
];

// 취득원가 적용가 = 취득원가 × (취득할인율%/100).
export function appliedCost(
  it: TangibleItem,
  k: "cur" | "pri" = "cur"
): number | null {
  const v = it.cost[k];
  if (v == null) return null;
  const pct = (k === "cur" ? it.costDiscountPctCur : it.costDiscountPctPri) ?? 100;
  return Math.round(v * (pct / 100));
}

// 감가상각누계액 적용가 = 누계액 × (감가할인율%/100). 누계 없으면 null.
export function appliedDep(
  it: TangibleItem,
  k: "cur" | "pri" = "cur"
): number | null {
  if (!it.acc_dep) return null;
  const v = it.acc_dep[k];
  if (v == null) return null;
  const pct = (k === "cur" ? it.depDiscountPctCur : it.depDiscountPctPri) ?? 100;
  return Math.round(v * (pct / 100));
}

// 순액 적용가 = 할인 적용된 취득원가 + 할인 적용된 감가상각누계액.
// (순액 자체엔 할인을 걸지 않음. no_dep이면 = 취득 적용가)
export function appliedValue(
  it: TangibleItem,
  k: "cur" | "pri" = "cur"
): number | null {
  const c = appliedCost(it, k);
  const d = appliedDep(it, k);
  if (c == null && d == null) return null;
  return (c ?? 0) + (d ?? 0);
}

export interface TangibleView {
  items: TangibleItem[];
  totals: TangibleTotals;
}

export interface CompanyView {
  company_key: string;
  company_raw: string;
  documents: DocType[];
  cost: CostView | null;
  tangible: TangibleView | null;
  fiscal: Fiscal;
  // PATCH 3: 소계 검산 실패 시 재촬영 배너
  recapture: { active: boolean; reasons: string[] };
}

// 유형자산 한 줄 계산 (순액 + 줄별 증감)
export function computeTangibleItem(r: TangibleRaw): TangibleItem {
  const cost = {
    cur: r.cost.cur,
    pri: r.cost.pri,
    delta: diff(r.cost.cur, r.cost.pri),
  };
  if (r.no_dep || r.acc_dep == null) {
    return {
      name: r.name,
      cost,
      acc_dep: null,
      net: { cur: cost.cur, pri: cost.pri },
      no_dep: true,
      status: r.status,
      note: r.note,
      costDiscountPctCur: null,
      costDiscountPctPri: null,
      depDiscountPctCur: null,
      depDiscountPctPri: null,
    };
  }
  const acc_dep = {
    cur: r.acc_dep.cur,
    pri: r.acc_dep.pri,
    delta: diff(r.acc_dep.cur, r.acc_dep.pri),
  };
  return {
    name: r.name,
    cost,
    acc_dep,
    net: {
      cur: addNullable(cost.cur, acc_dep.cur),
      pri: addNullable(cost.pri, acc_dep.pri),
    },
    no_dep: false,
    status: r.status,
    note: r.note,
    costDiscountPctCur: null,
    costDiscountPctPri: null,
    depDiscountPctCur: null,
    depDiscountPctPri: null,
  };
}

function addNullable(a: number | null, b: number | null): number | null {
  if (a == null && b == null) return null;
  return (a ?? 0) + (b ?? 0);
}

// 유형자산 합계 + 무결성 재계산
export function computeTangibleTotals(
  items: TangibleItem[],
  printed: { cur: number | null; pri: number | null }
): TangibleTotals {
  const sum = (k: "cur" | "pri") => {
    let acc = 0;
    let any = false;
    for (const it of items) {
      const v = it.net[k];
      if (v != null) {
        acc += v;
        any = true;
      }
    }
    return any ? acc : null;
  };
  const net = { cur: sum("cur"), pri: sum("pri") };

  // 그룹/전체 '적용가' 소계 — 할인율 반영(없음=순액). 당기/전기 각각, 이름으로 매칭.
  const sumApplied = (
    pred: (name: string) => boolean,
    k: "cur" | "pri"
  ): number | null => {
    let acc = 0;
    let any = false;
    for (const it of items) {
      if (!pred(it.name)) continue;
      const v = appliedValue(it, k);
      if (v != null) {
        acc += v;
        any = true;
      }
    }
    return any ? acc : null;
  };
  const all = () => true;
  const isMachine = (n: string) => /기계|시설|금형/.test(n);
  const isTools = (n: string) => /공구|비품/.test(n);
  const applied = { cur: sumApplied(all, "cur"), pri: sumApplied(all, "pri") };
  const subtotalMachine = {
    cur: sumApplied(isMachine, "cur"),
    pri: sumApplied(isMachine, "pri"),
  };
  const subtotalTools = {
    cur: sumApplied(isTools, "cur"),
    pri: sumApplied(isTools, "pri"),
  };

  // 원 단위 원본으로 정확 비교(드리프트/행밀림 감지). 한 칸만 밀려도 크게 어긋남.
  const ok = (a: number | null, b: number | null) =>
    a != null && b != null && a === b;

  return {
    net,
    printed,
    integrity: {
      cur: ok(net.cur, printed.cur),
      pri: ok(net.pri, printed.pri),
    },
    applied,
    subtotalMachine,
    subtotalTools,
  };
}

// 같은 종류 문서가 여러 장(분할 촬영)일 때, 품목별로 첫 non-null 값을 채택.
// prefer="pl"이면 손익(pl) 쪽 값을, "cogm"이면 제조 쪽 값을 우선.
function pickAcross(
  docs: ParsedDoc[],
  name: string,
  prefer: "pl" | "cogm"
): { value: number | null; status: ItemStatus | null; note: string } {
  let fallback: { status: ItemStatus; note: string } | null = null;
  for (const d of docs) {
    const it = d.items?.find((x) => x.name === name);
    if (!it) continue;
    const v = prefer === "pl" ? it.pl ?? it.cogm : it.cogm ?? it.pl;
    if (v != null) return { value: v, status: it.status, note: it.note };
    if (!fallback) fallback = { status: it.status, note: it.note };
  }
  return { value: null, status: fallback?.status ?? null, note: fallback?.note ?? "" };
}

// 비용 문서(손익 N장 + 제조원가 N장) 병합 → 16품목 합산표
function mergeCost(
  incomeDocs: ParsedDoc[],
  mfgDocs: ParsedDoc[]
): CostView {
  const items: CostItem[] = STANDARD_ITEMS.map((name) => {
    const inc = pickAcross(incomeDocs, name, "pl");
    const m = pickAcross(mfgDocs, name, "cogm");
    const pl = inc.value;
    const cogm = m.value;
    const statuses = [inc.status, m.status].filter(Boolean) as ItemStatus[];
    const status: ItemStatus = statuses.includes("exception")
      ? "exception"
      : statuses.includes("review")
      ? "review"
      : statuses.length
      ? "ok"
      : "review";
    const note = [inc.note, m.note]
      .filter((n) => n && n.trim())
      .filter((n, i, a) => a.indexOf(n) === i)
      .join(" / ");
    return { name, pl, cogm, total: computeTotal(pl, cogm), status, note };
  });

  // extras: 손익 문서들 중 첫 non-null 우선, 없으면 제조 문서
  const pickExtra = (k: "손익계산서_판관비" | "영업이익") => {
    for (const d of [...incomeDocs, ...mfgDocs]) {
      const v = d.extras?.[k];
      if (v != null) return v;
    }
    return null;
  };
  const extras = {
    손익계산서_판관비: pickExtra("손익계산서_판관비"),
    영업이익: pickExtra("영업이익"),
  };

  return { items, extras };
}

// 파싱 결과 배열 → 단일 뷰 (회사 그룹핑 없음).
// 사용자는 "한 번에 같은 회사 문서만" 올린다는 전제. 올린 문서를 전부 하나로 병합.
// 단, 회사명이 둘 이상으로 감지되면 표시용 이름에 병기해 섞임을 알 수 있게 한다.
export function buildCompanies(docs: ParsedDoc[]): CompanyView[] {
  if (!docs.length) return [];

  // 같은 문서종류가 여러 장(분할 촬영)이면 전부 모아 병합한다.
  const incomeDocs = docs.filter((d) => d.doc_type === "income_statement");
  const mfgDocs = docs.filter((d) => d.doc_type === "manufacturing_cost");
  const bsDocs = docs.filter(
    (d) => d.doc_type === "balance_sheet" && d.tangible_assets
  );

  const documents = docs
    .map((d) => d.doc_type)
    .filter((t, i, a) => a.indexOf(t) === i);

  const cost =
    incomeDocs.length || mfgDocs.length ? mergeCost(incomeDocs, mfgDocs) : null;

  let tangible: TangibleView | null = null;
  if (bsDocs.length) {
    const items = bsDocs
      .flatMap((d) => d.tangible_assets ?? [])
      .map(computeTangibleItem);
    const printed = bsDocs
      .map((d) => d.printed_total)
      .find((p) => p && (p.cur != null || p.pri != null)) ?? {
      cur: null,
      pri: null,
    };
    tangible = { items, totals: computeTangibleTotals(items, printed) };
  }

  // 표시용 회사명: 정규화 키 기준 distinct. 2개 이상이면 병기(섞임 경고용).
  const seen = new Map<string, string>();
  for (const d of docs) {
    const k = d.company_key || normalizeCompanyKey(d.company_raw);
    if (k && !seen.has(k)) seen.set(k, d.company_raw || k);
  }
  const names = [...seen.values()];
  const raw =
    names.length > 1 ? names.join("  /  ") : names[0] || "분석 결과";

  const fiscal =
    docs.find((d) => d.fiscal?.current || d.fiscal?.prior)?.fiscal || {
      current: null,
      prior: null,
    };

  // PATCH 3: 재촬영 사유(모델 자가검산). 재무상태표 무결성은 컴포넌트에서 '실시간'으로
  // 다시 검사하므로(셀 수정 시 자동 갱신) 여기 정적 사유에는 넣지 않는다.
  const reasons: string[] = [];
  for (const d of docs) {
    for (const r of d.recaptureReasons) {
      if (!reasons.includes(r)) reasons.push(r);
    }
  }

  return [
    {
      company_key: "all",
      company_raw: raw,
      documents,
      cost,
      tangible,
      fiscal,
      recapture: { active: reasons.length > 0, reasons },
    },
  ];
}
