"use client";

import { useMemo, useRef, useState } from "react";
import {
  buildCompanies,
  computeTangibleTotals,
  computeTotal,
  diff,
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

function fmt(n: number | null): string {
  if (n == null) return "–";
  return n.toLocaleString("en-US");
}

function signed(n: number | null): { text: string; cls: string } {
  if (n == null) return { text: "–", cls: "text-gray-400" };
  if (n === 0) return { text: "0", cls: "text-gray-400" };
  const s = n.toLocaleString("en-US");
  return n > 0
    ? { text: "+" + s, cls: "text-green-600" }
    : { text: s.replace("-", "−"), cls: "text-red-600" };
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
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
          const data = await res.json();
          if (!res.ok) {
            errs.push(`${f.name}: ${data?.error || "분석 실패"}`);
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
    if (docs.length) {
      const built = buildCompanies(docs);
      setCompanies(built);
      setActiveTab(0);
    } else {
      setCompanies(null);
    }
    setLoading(false);
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

  const active = companies && companies[activeTab];

  return (
    <main className="mx-auto max-w-[420px] min-h-screen px-3 pb-12 pt-3">
      <h1 className="text-base font-bold text-gray-800 mb-2">재무제표 파싱</h1>

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

      <button
        onClick={analyze}
        disabled={files.length === 0 || loading}
        className="mt-2 w-full h-10 rounded-md bg-blue-600 text-white font-semibold text-sm disabled:bg-gray-300 active:bg-blue-700"
      >
        {loading ? `분석 중… (${files.length}장)` : `분석 (${files.length}장)`}
      </button>

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
}) {
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
                <span className="text-[15px] font-bold tabular-nums text-gray-900">
                  {fmt(it.total)}
                </span>
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
      <NumInput
        value={value}
        onChange={onChange}
        className="w-32 text-[15px] font-bold text-gray-900 bg-white"
      />
    </div>
  );
}

// ───────────────────── 유형자산 표 ─────────────────────

function TangibleTable({
  tangible,
  onTangible,
}: {
  tangible: NonNullable<CompanyView["tangible"]>;
  onTangible: (
    ii: number,
    field: "cost" | "acc_dep",
    sub: "cur" | "pri",
    v: number | null
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

            {/* 순액 (보조) */}
            <div className="mt-1 flex items-center gap-3 text-[11px] text-gray-500">
              <span className="text-[10px] text-gray-400">순액</span>
              <span>당 {fmt(it.net.cur)}</span>
              <span>전 {fmt(it.net.pri)}</span>
            </div>

            {/* 취득원가 줄 */}
            <DeltaLine
              label="취득"
              cur={it.cost.cur}
              pri={it.cost.pri}
              delta={it.cost.delta}
              onCur={(v) => onTangible(i, "cost", "cur", v)}
              onPri={(v) => onTangible(i, "cost", "pri", v)}
            />

            {/* 감가상각누계액 줄 (no_dep이면 없음) */}
            {it.acc_dep && (
              <DeltaLine
                label="누계"
                cur={it.acc_dep.cur}
                pri={it.acc_dep.pri}
                delta={it.acc_dep.delta}
                onCur={(v) => onTangible(i, "acc_dep", "cur", v)}
                onPri={(v) => onTangible(i, "acc_dep", "pri", v)}
              />
            )}
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
            <span className="font-bold tabular-nums text-gray-900">
              {fmt(tangible.totals.net.cur)}
            </span>
            <div className="text-[10px] text-gray-400">
              인쇄 {fmt(tangible.totals.printed.cur)}{" "}
              {tangible.totals.integrity.cur ? "✓" : "✗"}
            </div>
          </div>
          <div>
            <span className="text-gray-400">전기 </span>
            <span className="font-bold tabular-nums text-gray-900">
              {fmt(tangible.totals.net.pri)}
            </span>
            <div className="text-[10px] text-gray-400">
              인쇄 {fmt(tangible.totals.printed.pri)}{" "}
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

      {notes.length > 0 && <NotesArea notes={notes} />}
    </>
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
  const d = signed(delta);
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
        <span className={`text-[14px] font-bold tabular-nums ${d.cls}`}>
          {d.text}
        </span>
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
