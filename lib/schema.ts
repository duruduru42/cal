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

// 회사명 정규화 → 그룹핑 키 (모델값을 신뢰하지 않고 클라이언트에서 한 번 더)
export function normalizeCompanyKey(raw: string | null | undefined): string {
  if (!raw) return "";
  let s = String(raw);
  s = s.replace(/\s+/g, ""); // 공백 전부 제거(자간 벌어짐 대응)
  s = s.replace(/^\d+[.\-]/, ""); // 앞쪽 코드 prefix( 1000. ) 제거
  s = s.replace(/[.··ㆍﾷ]/g, ""); // 가운뎃점·마침표 제거
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
      const pl = toNum(src?.pl);
      const cogm = toNum(src?.cogm);
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
      손익계산서_판관비: toNum(raw?.extras?.["손익계산서_판관비"]),
      영업이익: toNum(raw?.extras?.["영업이익"]),
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
          cost: { cur: toNum(t?.cost?.cur), pri: toNum(t?.cost?.pri) },
          acc_dep: no_dep
            ? null
            : { cur: toNum(t?.acc_dep?.cur), pri: toNum(t?.acc_dep?.pri) },
          no_dep,
          status: toStatus(t.status),
          note: typeof t.note === "string" ? t.note : "",
        };
      });
    printed_total = {
      cur: toNum(raw?.printed_total?.cur),
      pri: toNum(raw?.printed_total?.pri),
    };
  }

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
}

export interface TangibleTotals {
  net: { cur: number | null; pri: number | null };
  printed: { cur: number | null; pri: number | null };
  integrity: { cur: boolean; pri: boolean };
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
  return {
    net,
    printed,
    integrity: {
      cur: printed.cur != null && net.cur === printed.cur,
      pri: printed.pri != null && net.pri === printed.pri,
    },
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

// 파싱 결과 배열 → 회사별 뷰 (산수 포함)
export function buildCompanies(docs: ParsedDoc[]): CompanyView[] {
  const groups = new Map<string, ParsedDoc[]>();
  for (const d of docs) {
    const key = d.company_key || "(미분류)";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(d);
  }

  const out: CompanyView[] = [];
  for (const [key, list] of groups) {
    // 같은 문서종류가 여러 장(분할 촬영)이면 전부 모아 병합한다.
    const incomeDocs = list.filter((d) => d.doc_type === "income_statement");
    const mfgDocs = list.filter((d) => d.doc_type === "manufacturing_cost");
    const bsDocs = list.filter(
      (d) => d.doc_type === "balance_sheet" && d.tangible_assets
    );

    const documents = list
      .map((d) => d.doc_type)
      .filter((t, i, a) => a.indexOf(t) === i);

    const cost =
      incomeDocs.length || mfgDocs.length
        ? mergeCost(incomeDocs, mfgDocs)
        : null;

    let tangible: TangibleView | null = null;
    // 재무상태표도 여러 장이면 자산 줄을 합치고, printed_total은 첫 non-null 채택.
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

    const raw =
      list.find((d) => d.company_raw)?.company_raw || key;
    const fiscal =
      list.find((d) => d.fiscal?.current || d.fiscal?.prior)?.fiscal || {
        current: null,
        prior: null,
      };

    out.push({
      company_key: key,
      company_raw: raw,
      documents,
      cost,
      tangible,
      fiscal,
    });
  }
  return out;
}
