"use client";

import { useMemo, useRef, useState } from "react";
import {
  appliedCost,
  appliedDep,
  appliedValue,
  buildCompanies,
  computeTangibleTotals,
  computeTotal,
  diff,
  DISCOUNT_OPTIONS,
  DOC_LABEL,
  type CompanyView,
  type ItemStatus,
  type ParsedDoc,
  type TangibleItem,
} from "@/lib/schema";

const BADGE: Record<ItemStatus, string> = {
  ok: "✅",
  exception: "⚠️",
  review: "❓",
};

// PATCH 2 표기: 최종값을 가장 가까운 백만으로 반올림해 백만 단위 정수로 표기(끝 0 생략).
// 단, 100만원 미만은 반올림하지 않고 원 단위 원본값 그대로(작게 '원' 표시).
function amt(v: number | null): { text: string; won: boolean } {
  if (v == null) return { text: "–", won: false };
  if (Math.abs(v) < 1_000_000) return { text: v.toLocaleString("en-US"), won: true };
  return { text: Math.round(v / 1_000_000).toLocaleString("en-US"), won: false };
}

// 읽기 전용 금액 표시 (백만원 단위, <100만은 원)
function Amt({ v, className }: { v: number | null; className?: string }) {
  const a = amt(v);
  return (
    <span className={className}>
      <span className="tabular-nums">{a.text}</span>
      {a.won && <span className="text-[9px] text-gray-400 ml-0.5">원</span>}
    </span>
  );
}

// 증감(부호+색상) 표시 — 백만원 단위, <100만은 원
function AmtSigned({ v, className }: { v: number | null; className?: string }) {
  if (v == null) return <span className={`text-gray-400 ${className ?? ""}`}>–</span>;
  if (v === 0) return <span className={`text-gray-400 ${className ?? ""}`}>0</span>;
  const big = Math.abs(v) >= 1_000_000;
  const shown = big ? Math.round(v / 1_000_000) : v;
  const won = !big;
  const mag = Math.abs(shown).toLocaleString("en-US");
  const cls = v > 0 ? "text-green-600" : "text-red-600";
  return (
    <span className={`${cls} ${className ?? ""}`}>
      <span className="tabular-nums">
        {v > 0 ? "+" : "−"}
        {mag}
      </span>
      {won && <span className="text-[9px] opacity-60 ml-0.5">원</span>}
    </span>
  );
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

// 업로드 전 이미지 축소 (긴 변 maxDim, JPEG 재인코딩).
// Anthropic Vision이 어차피 ~1568px로 다운스케일하므로 화질 손해 없이
// 요청 본문 크기를 크게 줄여 413(Request Entity Too Large)을 방지한다.
function downscale(dataUrl: string, maxDim = 1568, quality = 0.82): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const longest = Math.max(img.width, img.height);
      const scale = longest > maxDim ? maxDim / longest : 1;
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return resolve(dataUrl);
      ctx.drawImage(img, 0, 0, w, h);
      try {
        resolve(canvas.toDataURL("image/jpeg", quality));
      } catch {
        resolve(dataUrl); // 변환 실패 시 원본
      }
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

async function fileToDataUrl(file: File): Promise<string> {
  const raw = await readAsDataUrl(file);
  return downscale(raw);
}

interface UploadFile {
  id: string;
  name: string;
  dataUrl: string;
}

// 편집 가능한 숫자 셀 (콤마 무시, 음수 허용)
function NumInput({
  value,
  onChange,
  className,
  align = "right",
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  className?: string;
  align?: "right" | "left";
}) {
  return (
    <input
      className={`cell-edit bg-gray-50 border border-gray-200 rounded px-1 py-0.5 focus:bg-white focus:border-blue-400 outline-none text-${align} ${
        className ?? ""
      }`}
      inputMode="numeric"
      value={value == null ? "" : value.toLocaleString("en-US")}
      placeholder="–"
      onChange={(e) => {
        const raw = e.target.value.replace(/[^0-9-]/g, "");
        if (raw === "" || raw === "-") return onChange(null);
        const n = Number(raw);
        onChange(Number.isFinite(n) ? n : null);
      }}
    />
  );
}

// 유형자산 한 줄 재계산(편집 후)
function recomputeItem(it: TangibleItem): TangibleItem {
  const costDelta = diff(it.cost.cur, it.cost.pri);
  if (it.no_dep || !it.acc_dep) {
    return {
      ...it,
      cost: { ...it.cost, delta: costDelta },
      acc_dep: null,
      net: { cur: it.cost.cur, pri: it.cost.pri },
    };
  }
  const accDelta = diff(it.acc_dep.cur, it.acc_dep.pri);
  const netCur =
    it.cost.cur == null && it.acc_dep.cur == null
      ? null
      : (it.cost.cur ?? 0) + (it.acc_dep.cur ?? 0);
  const netPri =
    it.cost.pri == null && it.acc_dep.pri == null
      ? null
      : (it.cost.pri ?? 0) + (it.acc_dep.pri ?? 0);
  return {
    ...it,
    cost: { ...it.cost, delta: costDelta },
    acc_dep: { ...it.acc_dep, delta: accDelta },
    net: { cur: netCur, pri: netPri },
  };
}

export default function Home() {
  const [files, setFiles] = useState<UploadFile[]>([]);
  const [companies, setCompanies] = useState<CompanyView[] | null>(null);
  const [activeTab, setActiveTab] = useState(0);
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [recaptureDismissed, setRecaptureDismissed] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function addFiles(list: FileList) {
    const next: UploadFile[] = [];
    for (const f of Array.from(list)) {
      next.push({
        id: `${f.name}-${f.size}-${next.length}-${files.length}`,
        name: f.name,
        dataUrl: await fileToDataUrl(f),
      });
    }
    setFiles((prev) => [...prev, ...next]);
  }

  function removeFile(id: string) {
    setFiles((prev) => prev.filter((f) => f.id !== id));
  }

  async function analyze() {
    if (files.length === 0) return;
    setLoading(true);
    setErrors([]);
    const errs: string[] = [];
    const results = await Promise.all(
      files.map(async (f) => {
        try {
          const res = await fetch("/api/parse", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ image: f.dataUrl }),
          });
          // 비-JSON 응답(413/HTML 등)도 깨끗한 메시지로 처리
          const text = await res.text();
          let data: any = null;
          try {
            data = JSON.parse(text);
          } catch {
            data = null;
          }
          if (!res.ok || !data) {
            const msg = data?.error
              ? data.error
              : res.status === 413
              ? "이미지 용량이 너무 큽니다 (축소 후에도 초과)."
              : `서버 오류 (HTTP ${res.status})`;
            errs.push(`${f.name}: ${msg}`);
            return null;
          }
          return data as ParsedDoc;
        } catch (e: any) {
          errs.push(`${f.name}: ${e?.message || "네트워크 오류"}`);
          return null;
        }
      })
    );
    const docs = results.filter((d): d is ParsedDoc => d != null);
    setErrors(errs);
    setRecaptureDismissed(false);
    if (docs.length) {
      setCompanies(buildCompanies(docs));
      setActiveTab(0);
    } else {
      setCompanies(null);
    }
    setLoading(false);
  }

  // 새로고침: 사진·결과를 전부 비워 처음 상태로(사진 일일이 ✕ 안 눌러도 됨)
  function refreshAll() {
    setFiles([]);
    setCompanies(null);
    setErrors([]);
    setRecaptureDismissed(false);
    setActiveTab(0);
  }

  function updateCost(
    ci: number,
    ii: number,
    key: "pl" | "cogm",
    v: number | null
  ) {
    setCompanies((prev) => {
      if (!prev) return prev;
      const cs = prev.slice();
      const c = { ...cs[ci] };
      if (!c.cost) return prev;
      const items = c.cost.items.slice();
      const it = { ...items[ii], [key]: v };
      it.total = computeTotal(it.pl, it.cogm);
      items[ii] = it;
      c.cost = { ...c.cost, items };
      cs[ci] = c;
      return cs;
    });
  }

  function updateExtra(
    ci: number,
    key: "손익계산서_판관비" | "영업이익",
    v: number | null
  ) {
    setCompanies((prev) => {
      if (!prev) return prev;
      const cs = prev.slice();
      const c = { ...cs[ci] };
      if (!c.cost) return prev;
      c.cost = { ...c.cost, extras: { ...c.cost.extras, [key]: v } };
      cs[ci] = c;
      return cs;
    });
  }

  function updateTangible(
    ci: number,
    ii: number,
    field: "cost" | "acc_dep",
    sub: "cur" | "pri",
    v: number | null
  ) {
    setCompanies((prev) => {
      if (!prev) return prev;
      const cs = prev.slice();
      const c = { ...cs[ci] };
      if (!c.tangible) return prev;
      const items = c.tangible.items.slice();
      let it = { ...items[ii] };
      if (field === "cost") {
        it.cost = { ...it.cost, [sub]: v };
      } else if (it.acc_dep) {
        it.acc_dep = { ...it.acc_dep, [sub]: v };
      }
      it = recomputeItem(it);
      items[ii] = it;
      const totals = computeTangibleTotals(items, c.tangible.totals.printed);
      c.tangible = { items, totals };
      cs[ci] = c;
      return cs;
    });
  }

  function updateDiscount(
    ci: number,
    ii: number,
    target: "cost" | "dep",
    period: "cur" | "pri",
    pct: number | null
  ) {
    setCompanies((prev) => {
      if (!prev) return prev;
      const cs = prev.slice();
      const c = { ...cs[ci] };
      if (!c.tangible) return prev;
      const items = c.tangible.items.slice();
      const key =
        target === "cost"
          ? period === "cur"
            ? "costDiscountPctCur"
            : "costDiscountPctPri"
          : period === "cur"
          ? "depDiscountPctCur"
          : "depDiscountPctPri";
      items[ii] = { ...items[ii], [key]: pct };
      const totals = computeTangibleTotals(items, c.tangible.totals.printed);
      c.tangible = { items, totals };
      cs[ci] = c;
      return cs;
    });
  }

  const active = companies && companies[activeTab];

  return (
    <main className="mx-auto max-w-[420px] min-h-screen px-3 pb-12 pt-3">
      <div className="flex items-baseline justify-between mb-2">
        <h1 className="text-base font-bold text-gray-800">재무제표 파싱</h1>
        <span className="text-[10px] font-semibold text-blue-700 bg-blue-50 border border-blue-200 rounded px-1.5 py-0.5">
          백만원 반올림 (백만 미만 그대로)
        </span>
      </div>

      {/* 다중 업로드 */}
      <div className="rounded-md border-2 border-dashed border-gray-300 bg-white p-2">
        <button
          onClick={() => inputRef.current?.click()}
          className="w-full h-10 text-sm text-gray-500 active:bg-gray-50"
        >
          + 사진 여러 장 선택 (손익·제조원가·재무상태표 섞어도 됨)
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
            e.target.value = "";
          }}
        />
        {files.length > 0 && (
          <div className="mt-2 grid grid-cols-4 gap-1.5">
            {files.map((f) => (
              <div key={f.id} className="relative">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={f.dataUrl}
                  alt={f.name}
                  className="w-full h-16 object-cover rounded border border-gray-200"
                />
                <button
                  onClick={() => removeFile(f.id)}
                  className="absolute top-0.5 right-0.5 bg-black/60 text-white text-[10px] leading-none w-4 h-4 rounded-full"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="mt-2 flex gap-2">
        <button
          onClick={analyze}
          disabled={files.length === 0 || loading}
          className="flex-1 h-10 rounded-md bg-blue-600 text-white font-semibold text-sm disabled:bg-gray-300 active:bg-blue-700"
        >
          {loading ? `분석 중… (${files.length}장)` : `분석 (${files.length}장)`}
        </button>
        {(files.length > 0 || companies) && (
          <button
            onClick={refreshAll}
            disabled={loading}
            className="h-10 px-3 rounded-md border border-gray-300 bg-white text-gray-600 font-semibold text-sm active:bg-gray-50"
            title="사진과 결과를 모두 비웁니다 (사진 일일이 ✕ 안 눌러도 됨)"
          >
            ↻ 새로고침
          </button>
        )}
      </div>

      {errors.length > 0 && (
        <div className="mt-2 rounded-md bg-red-50 border border-red-200 text-red-700 text-[11px] px-2 py-2 space-y-0.5">
          {errors.map((e, i) => (
            <div key={i}>{e}</div>
          ))}
        </div>
      )}

      {/* 회사 탭 (회사 1개면 숨김) */}
      {companies && companies.length > 1 && (
        <div className="mt-3 flex gap-1.5 overflow-x-auto pb-1">
          {companies.map((c, i) => (
            <button
              key={c.company_key}
              onClick={() => setActiveTab(i)}
              className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-semibold border ${
                i === activeTab
                  ? "bg-blue-600 text-white border-blue-600"
                  : "bg-white text-gray-600 border-gray-300"
              }`}
            >
              {c.company_raw}
            </button>
          ))}
        </div>
      )}

      {active && (
        <CompanyBlock
          key={active.company_key}
          company={active}
          single={!!companies && companies.length === 1}
          onCost={(ii, key, v) => updateCost(activeTab, ii, key, v)}
          onExtra={(key, v) => updateExtra(activeTab, key, v)}
          onTangible={(ii, field, sub, v) =>
            updateTangible(activeTab, ii, field, sub, v)
          }
          onDiscount={(ii, target, period, pct) =>
            updateDiscount(activeTab, ii, target, period, pct)
          }
          dismissed={recaptureDismissed}
          onDismiss={() => setRecaptureDismissed(true)}
        />
      )}

      {!companies && !loading && (
        <p className="mt-6 text-center text-xs text-gray-400">
          사진들을 올리고 분석을 누르세요.
        </p>
      )}
    </main>
  );
}

function CompanyBlock({
  company,
  single,
  onCost,
  onExtra,
  onTangible,
  onDiscount,
  dismissed,
  onDismiss,
}: {
  company: CompanyView;
  single: boolean;
  onCost: (ii: number, key: "pl" | "cogm", v: number | null) => void;
  onExtra: (key: "손익계산서_판관비" | "영업이익", v: number | null) => void;
  onTangible: (
    ii: number,
    field: "cost" | "acc_dep",
    sub: "cur" | "pri",
    v: number | null
  ) => void;
  onDiscount: (
    ii: number,
    target: "cost" | "dep",
    period: "cur" | "pri",
    pct: number | null
  ) => void;
  dismissed: boolean;
  onDismiss: () => void;
}) {
  // 재무상태표 무결성은 '현재 셀 값' 기준으로 실시간 재검사 → 맞으면 자동으로 사라짐
  const t = company.tangible?.totals;
  const bsFail = !!(
    t &&
    ((t.printed.cur != null && !t.integrity.cur) ||
      (t.printed.pri != null && !t.integrity.pri))
  );
  // 모델이 지적한 사유(제조/손익 등): 사용자가 셀 수정 후 '닫기'로 없앰
  const showModelReasons = company.recapture.active && !dismissed;
  const showBanner = showModelReasons || bsFail;

  return (
    <div className="mt-3">
      {single && (
        <div className="mb-1 text-sm font-bold text-gray-800">
          {company.company_raw}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1 mb-2">
        {company.documents.map((d) => (
          <span
            key={d}
            className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500"
          >
            {DOC_LABEL[d]}
          </span>
        ))}
        {company.fiscal.current && (
          <span className="text-[10px] text-gray-400 ml-auto">
            {company.fiscal.current}
            {company.fiscal.prior ? ` / ${company.fiscal.prior}` : ""}
          </span>
        )}
      </div>

      {showBanner && (
        <div className="mb-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2">
          <div className="text-xs font-bold text-red-700">
            ❓ 숫자가 정확히 안 맞아요. 종이를 평평하게 펴서 다시 찍어 올려주세요.
          </div>
          <ul className="mt-1 space-y-0.5">
            {showModelReasons &&
              company.recapture.reasons.map((r, i) => (
                <li key={i} className="text-[11px] leading-snug text-red-800">
                  · {r}
                </li>
              ))}
            {bsFail && (
              <li className="text-[11px] leading-snug text-red-800">
                · 유형자산 숫자 줄이 한 칸씩 밀린 것 같아요. 합계가 맞지 않습니다.
                종이가 구겨져 있으면 그럴 수 있어요. 평평하게 펴서 다시 찍거나, 아래
                칸의 숫자를 직접 고쳐 주세요.
              </li>
            )}
          </ul>
          <div className="mt-1.5 flex items-center justify-between">
            <span className="text-[10px] text-red-500">
              값은 아래에 보이지만 정확하지 않을 수 있어요.
            </span>
            {showModelReasons && (
              <button
                onClick={onDismiss}
                className="text-[11px] font-semibold text-red-700 bg-white border border-red-300 rounded px-2 py-0.5 active:bg-red-100"
              >
                숫자 확인함 · 안내 닫기
              </button>
            )}
          </div>
        </div>
      )}

      {company.cost && (
        <Section title="비용 합산표">
          <CostTable cost={company.cost} onCost={onCost} onExtra={onExtra} />
        </Section>
      )}

      {company.tangible && (
        <Section title="유형자산 (재무상태표)">
          <TangibleTable
            tangible={company.tangible}
            onTangible={onTangible}
            onDiscount={onDiscount}
          />
        </Section>
      )}

      {!company.cost && !company.tangible && (
        <p className="text-center text-xs text-gray-400 py-4">
          분류 가능한 표가 없습니다 (미분류 문서).
        </p>
      )}
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className="mb-3">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between text-xs font-bold text-gray-700 mb-1"
      >
        <span>{title}</span>
        <span className="text-gray-400">{open ? "▲ 접기" : "▼ 펴기"}</span>
      </button>
      {open && children}
    </div>
  );
}

// ───────────────────── 비용 합산표 ─────────────────────

function CostTable({
  cost,
  onCost,
  onExtra,
}: {
  cost: CompanyView["cost"];
  onCost: (ii: number, key: "pl" | "cogm", v: number | null) => void;
  onExtra: (key: "손익계산서_판관비" | "영업이익", v: number | null) => void;
}) {
  const notes = useMemo(() => {
    if (!cost) return [];
    return cost.items
      .filter((it) => it.status === "exception" || it.status === "review")
      .map((it) => ({
        badge: BADGE[it.status],
        name: it.name,
        text:
          it.note ||
          (it.status === "review" ? "문서에서 확인되지 않음 / 원본 확인 필요." : ""),
      }));
  }, [cost]);

  if (!cost) return null;

  return (
    <>
      <div className="rounded-lg overflow-hidden border border-gray-200 bg-white">
        {cost.items.map((it, i) => (
          <div
            key={it.name}
            className="px-2.5 py-1.5 border-b border-gray-100 last:border-b-0"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-gray-800 truncate">
                {it.name}
              </span>
              <span className="text-xs shrink-0">{BADGE[it.status]}</span>
            </div>
            <div className="flex items-center justify-between gap-1 mt-0.5">
              <div className="flex items-center gap-2 min-w-0">
                <span className="inline-flex items-baseline gap-1">
                  <span className="text-[10px] text-gray-400">손익</span>
                  <NumInput
                    value={it.pl}
                    onChange={(v) => onCost(i, "pl", v)}
                    className="w-[5.2rem] text-[11px] text-gray-700"
                  />
                </span>
                <span className="inline-flex items-baseline gap-1">
                  <span className="text-[10px] text-gray-400">제조</span>
                  <NumInput
                    value={it.cogm}
                    onChange={(v) => onCost(i, "cogm", v)}
                    className="w-[5.2rem] text-[11px] text-gray-700"
                  />
                </span>
              </div>
              <div className="flex items-baseline gap-1 shrink-0">
                <span className="text-[10px] text-gray-400">합산</span>
                <Amt
                  v={it.total}
                  className="text-[15px] font-bold text-gray-900"
                />
              </div>
            </div>
          </div>
        ))}

        <ExtraRow
          name="손익계산서 판관비"
          value={cost.extras["손익계산서_판관비"]}
          onChange={(v) => onExtra("손익계산서_판관비", v)}
        />
        <ExtraRow
          name="영업이익"
          value={cost.extras["영업이익"]}
          onChange={(v) => onExtra("영업이익", v)}
          last
        />
      </div>

      {notes.length > 0 && <NotesArea notes={notes} />}
    </>
  );
}

function ExtraRow({
  name,
  value,
  onChange,
  last,
}: {
  name: string;
  value: number | null;
  onChange: (v: number | null) => void;
  last?: boolean;
}) {
  return (
    <div
      className={`px-2.5 py-1.5 bg-slate-50 ${
        last ? "" : "border-b border-gray-100"
      } flex items-center justify-between gap-2`}
    >
      <span className="text-xs font-semibold text-gray-700">{name}</span>
      <div className="flex items-baseline gap-2 shrink-0">
        {/* 원 단위 원본(편집·검산용, 작게) */}
        <NumInput
          value={value}
          onChange={onChange}
          className="w-28 text-[11px] text-gray-500 bg-white"
        />
        {/* 백만원 표기(복사용, 크게) */}
        <Amt v={value} className="text-[15px] font-bold text-gray-900" />
      </div>
    </div>
  );
}

// 할인율 한 줄(당기 또는 전기): [라벨][할인율 select][적용가]
function DiscountRow({
  label,
  pct,
  applied,
  onChange,
  strong,
  tone = "indigo",
}: {
  label: string;
  pct: number | null;
  applied: number | null;
  onChange: (pct: number | null) => void;
  strong?: boolean;
  tone?: "indigo" | "rose";
}) {
  const labelCls = tone === "rose" ? "text-rose-500" : "text-indigo-500";
  const borderCls = tone === "rose" ? "border-rose-200" : "border-indigo-200";
  const valStrong = tone === "rose" ? "text-rose-700" : "text-indigo-700";
  const valSoft = tone === "rose" ? "text-rose-500" : "text-indigo-500";
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex items-center gap-1 shrink-0">
        <span className={`text-[10px] font-semibold w-5 ${labelCls}`}>
          {label}
        </span>
        <span className="text-[10px] text-gray-500">할인율</span>
        <select
          value={pct ?? ""}
          onChange={(e) =>
            onChange(e.target.value === "" ? null : Number(e.target.value))
          }
          className={`text-[11px] border rounded px-1 py-0.5 bg-white ${borderCls}`}
        >
          {DISCOUNT_OPTIONS.map((o) => (
            <option key={o ?? "none"} value={o ?? ""}>
              {o == null ? "없음" : `${o}%`}
            </option>
          ))}
        </select>
      </div>
      <div className="flex items-baseline gap-1 shrink-0">
        <span className="text-[10px] text-gray-500">적용가</span>
        <Amt
          v={applied}
          className={
            strong
              ? `text-[15px] font-bold ${valStrong}`
              : `text-[14px] font-bold ${valSoft}`
          }
        />
      </div>
    </div>
  );
}

// ───────────────────── 유형자산 표 ─────────────────────

function TangibleTable({
  tangible,
  onTangible,
  onDiscount,
}: {
  tangible: NonNullable<CompanyView["tangible"]>;
  onTangible: (
    ii: number,
    field: "cost" | "acc_dep",
    sub: "cur" | "pri",
    v: number | null
  ) => void;
  onDiscount: (
    ii: number,
    target: "cost" | "dep",
    period: "cur" | "pri",
    pct: number | null
  ) => void;
}) {
  const notes = useMemo(
    () =>
      tangible.items
        .filter((it) => it.status === "exception" || it.status === "review")
        .map((it) => ({
          badge: BADGE[it.status],
          name: it.name,
          text:
            it.note ||
            (it.no_dep
              ? "감가상각누계액 없음 → 취득원가를 그대로 순액으로 사용."
              : it.status === "review"
              ? "항목 판독 흐림. 원본 라벨 확인 필요."
              : ""),
        })),
    [tangible]
  );

  return (
    <>
      <div className="space-y-2">
        {tangible.items.map((it, i) => (
          <div
            key={it.name + i}
            className="rounded-lg border border-gray-200 bg-white px-2.5 py-2"
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-gray-800">{it.name}</span>
              <span className="text-xs">{BADGE[it.status]}</span>
            </div>

            {/* 취득원가 줄 (원본 편집) */}
            <DeltaLine
              label="취득"
              cur={it.cost.cur}
              pri={it.cost.pri}
              delta={it.cost.delta}
              onCur={(v) => onTangible(i, "cost", "cur", v)}
              onPri={(v) => onTangible(i, "cost", "pri", v)}
            />

            {/* 취득원가 할인 (당기/전기) + 적용가 + 증감 */}
            <div className="mt-1 bg-indigo-50 rounded px-1.5 py-1 space-y-1">
              <div className="text-[10px] font-bold text-indigo-700">
                취득원가 할인
              </div>
              <DiscountRow
                label="당기"
                pct={it.costDiscountPctCur}
                applied={appliedCost(it, "cur")}
                onChange={(p) => onDiscount(i, "cost", "cur", p)}
                strong
              />
              <DiscountRow
                label="전기"
                pct={it.costDiscountPctPri}
                applied={appliedCost(it, "pri")}
                onChange={(p) => onDiscount(i, "cost", "pri", p)}
              />
              <div className="flex items-center justify-end gap-1 pt-0.5 border-t border-indigo-100">
                <span className="text-[10px] text-gray-500">증감</span>
                <AmtSigned
                  v={diff(appliedCost(it, "cur"), appliedCost(it, "pri"))}
                  className="text-[14px] font-bold"
                />
              </div>
            </div>

            {/* 감가상각누계액 줄 + 할인 (누계 있는 항목만) */}
            {it.acc_dep && (
              <>
                <DeltaLine
                  label="누계"
                  cur={it.acc_dep.cur}
                  pri={it.acc_dep.pri}
                  delta={it.acc_dep.delta}
                  onCur={(v) => onTangible(i, "acc_dep", "cur", v)}
                  onPri={(v) => onTangible(i, "acc_dep", "pri", v)}
                />
                <div className="mt-1 bg-rose-50 rounded px-1.5 py-1 space-y-1">
                  <div className="text-[10px] font-bold text-rose-700">
                    감가(누계) 할인
                  </div>
                  <DiscountRow
                    label="당기"
                    pct={it.depDiscountPctCur}
                    applied={appliedDep(it, "cur")}
                    onChange={(p) => onDiscount(i, "dep", "cur", p)}
                    tone="rose"
                    strong
                  />
                  <DiscountRow
                    label="전기"
                    pct={it.depDiscountPctPri}
                    applied={appliedDep(it, "pri")}
                    onChange={(p) => onDiscount(i, "dep", "pri", p)}
                    tone="rose"
                  />
                  <div className="flex items-center justify-end gap-1 pt-0.5 border-t border-rose-100">
                    <span className="text-[10px] text-gray-500">증감</span>
                    <AmtSigned
                      v={diff(appliedDep(it, "cur"), appliedDep(it, "pri"))}
                      className="text-[14px] font-bold"
                    />
                  </div>
                </div>
              </>
            )}

            {/* 순액(적용) = 할인 적용 취득 + 할인 적용 감가. 할인 없음·증감만 */}
            <div className="mt-1 rounded px-1.5 py-1 bg-gray-100 border border-gray-200">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-bold text-gray-700">
                  순액(적용)
                </span>
                <div className="flex items-baseline gap-2">
                  <span className="flex items-baseline gap-0.5">
                    <span className="text-[9px] text-gray-400">당</span>
                    <Amt
                      v={appliedValue(it, "cur")}
                      className="text-[15px] font-bold text-gray-900"
                    />
                  </span>
                  <span className="flex items-baseline gap-0.5">
                    <span className="text-[9px] text-gray-400">전</span>
                    <Amt
                      v={appliedValue(it, "pri")}
                      className="text-[13px] font-bold text-gray-600"
                    />
                  </span>
                </div>
              </div>
              <div className="flex items-center justify-end gap-1">
                <span className="text-[10px] text-gray-500">증감</span>
                <AmtSigned
                  v={diff(appliedValue(it, "cur"), appliedValue(it, "pri"))}
                  className="text-[14px] font-bold"
                />
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* 합계 + 무결성 */}
      <div className="mt-2 rounded-lg border border-gray-300 bg-slate-50 px-2.5 py-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-bold text-gray-800">순액 합계</span>
          <span className="text-xs">
            {tangible.totals.integrity.cur && tangible.totals.integrity.pri
              ? "✅"
              : "❓"}
          </span>
        </div>
        <div className="mt-1 grid grid-cols-2 gap-2 text-[11px]">
          <div>
            <span className="text-gray-400">당기 </span>
            <Amt v={tangible.totals.net.cur} className="font-bold text-gray-900" />
            <div className="text-[10px] text-gray-400">
              인쇄 <Amt v={tangible.totals.printed.cur} />{" "}
              {tangible.totals.integrity.cur ? "✓" : "✗"}
            </div>
          </div>
          <div>
            <span className="text-gray-400">전기 </span>
            <Amt v={tangible.totals.net.pri} className="font-bold text-gray-900" />
            <div className="text-[10px] text-gray-400">
              인쇄 <Amt v={tangible.totals.printed.pri} />{" "}
              {tangible.totals.integrity.pri ? "✓" : "✗"}
            </div>
          </div>
        </div>
        {!(tangible.totals.integrity.cur && tangible.totals.integrity.pri) && (
          <div className="mt-1 text-[10px] text-amber-700">
            합계 불일치 — 페어링(자산↔누계액) 확인 필요.
          </div>
        )}
      </div>

      {/* 그룹 소계 (당기/전기, 할인 적용가 기준) — 할인율 바꾸면 즉시 반영 */}
      <SubtotalRow
        label="기계장치 · 시설장치 · 금형 (적용가)"
        cur={tangible.totals.subtotalMachine.cur}
        pri={tangible.totals.subtotalMachine.pri}
      />
      <SubtotalRow
        label="공구와기구 · 비품 (적용가)"
        cur={tangible.totals.subtotalTools.cur}
        pri={tangible.totals.subtotalTools.pri}
      />

      {/* 할인 적용가 합계 (당기/전기) — 주인공 */}
      <div className="mt-2 rounded-lg border border-indigo-300 bg-indigo-50 px-2.5 py-2">
        <div className="text-xs font-bold text-indigo-900">할인 적용가 합계</div>
        <div className="mt-1 flex items-center justify-between gap-3">
          <div className="flex items-baseline gap-1">
            <span className="text-[10px] text-indigo-500">당기</span>
            <Amt
              v={tangible.totals.applied.cur}
              className="text-[18px] font-bold text-indigo-700"
            />
          </div>
          <div className="flex items-baseline gap-1">
            <span className="text-[10px] text-indigo-500">전기</span>
            <Amt
              v={tangible.totals.applied.pri}
              className="text-[16px] font-bold text-indigo-500"
            />
          </div>
        </div>
      </div>

      {notes.length > 0 && <NotesArea notes={notes} />}
    </>
  );
}

// 그룹 순액 소계 한 줄: 당기/전기 (백만원 단위)
function SubtotalRow({
  label,
  cur,
  pri,
}: {
  label: string;
  cur: number | null;
  pri: number | null;
}) {
  return (
    <div className="mt-2 rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-2">
      <div className="text-xs font-bold text-emerald-900">{label}</div>
      <div className="mt-1 flex items-center justify-between gap-3">
        <div className="flex items-baseline gap-1">
          <span className="text-[10px] text-emerald-500">당기</span>
          <Amt v={cur} className="text-[17px] font-bold text-emerald-700" />
        </div>
        <div className="flex items-baseline gap-1">
          <span className="text-[10px] text-emerald-500">전기</span>
          <Amt v={pri} className="text-[15px] font-bold text-emerald-600" />
        </div>
      </div>
    </div>
  );
}

// 취득원가/누계액 한 줄 (당·전 편집 + 증감 강조)
function DeltaLine({
  label,
  cur,
  pri,
  delta,
  onCur,
  onPri,
}: {
  label: string;
  cur: number | null;
  pri: number | null;
  delta: number | null;
  onCur: (v: number | null) => void;
  onPri: (v: number | null) => void;
}) {
  return (
    <div className="mt-1 flex items-center justify-between gap-1">
      <div className="flex items-center gap-1.5 min-w-0">
        <span className="text-[10px] text-gray-400 w-6 shrink-0">{label}</span>
        <NumInput
          value={cur}
          onChange={onCur}
          className="w-[5.3rem] text-[11px] text-gray-700"
        />
        <NumInput
          value={pri}
          onChange={onPri}
          className="w-[5.3rem] text-[11px] text-gray-500"
        />
      </div>
      <div className="flex items-baseline gap-1 shrink-0">
        <span className="text-[10px] text-gray-400">증감</span>
        <AmtSigned v={delta} className="text-[14px] font-bold" />
      </div>
    </div>
  );
}

function NotesArea({
  notes,
}: {
  notes: { badge: string; name: string; text: string }[];
}) {
  return (
    <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
      <div className="text-[11px] font-semibold text-amber-800 mb-1">
        확인 필요 항목
      </div>
      <ul className="space-y-1">
        {notes.map((n, i) => (
          <li key={i} className="text-[11px] leading-snug text-amber-900">
            <span className="mr-1">{n.badge}</span>
            <span className="font-medium">{n.name}</span>
            {n.text && <span className="text-amber-800">: {n.text}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
