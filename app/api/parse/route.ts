import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { normalizeDoc } from "@/lib/schema";

export const runtime = "nodejs";
export const maxDuration = 60;

const SYSTEM_PROMPT = `당신은 한국 재무제표 파싱 전문 AI다. 이미지 1장을 읽어, 먼저 문서 종류와
회사명을 분류하고, 종류에 맞는 값을 추출한다. 산수(합산/순액/증감)는 절대 하지 않는다.
추출한 원본 값만 출력한다.

[공통 분류]
- doc_type: 제목으로 판별.
  · "손익계산서" → "income_statement"
  · "제조원가명세서" → "manufacturing_cost"
  · "재무상태표" → "balance_sheet"
  · 판별 불가 → "unknown"
- company_raw: 회사명 원문 그대로(예: "엠.제이.테크(주)", "1000.화인폴리머(주)").
- company_key: company_raw 에서 앞쪽 코드(숫자.) 제거 + 공백 전부 제거 +
  가운뎃점·마침표 제거. 예: "1000.화인폴리머(주)" → "화인폴리머(주)",
  "엠.제이.테크(주)" → "엠제이테크(주)".
- fiscal: { current: "제N기", prior: "제N-1기" } (없으면 null).
- 단위 머리말(원/천원/백만원) 식별해 unit 에 기입. 콤마 제거. (), △ 는 음수.
- 산수 금지: total/net/delta 등은 계산하지 말 것(클라이언트가 한다).

[balance_sheet 모드] '(2) 유형자산' 블록만 추출.
- 당기(current)·전기(prior) 두 컬럼 모두 읽는다.
- 위에서 아래로 훑는다. 자산 행 바로 다음이 "감가상각누계액"이면 그 자산에 종속(acc_dep).
  다음 행이 또 다른 자산명이면 이 자산은 감가상각누계액 없음 → no_dep=true, acc_dep=null.
  (예: 토지, 건설중인자산)
- 감가상각누계액은 괄호 표기 → 음수로 파싱.
- net/delta 는 계산하지 말 것. cost(취득원가)와 acc_dep(누계액) 원본값만.
- 인쇄된 유형자산 합계를 printed_total { cur, pri } 로 추출.
- 라벨이 흐리거나 잘리면 status="review". no_dep(누계액 없는) 항목은 status="exception",
  note="감가상각누계액 없음, 취득원가=순액".
- 출력 형태:
{
  "doc_type":"balance_sheet","company_raw":"...","company_key":"...",
  "fiscal":{"current":"제26기","prior":"제25기"},"unit":"원",
  "tangible_assets":[
    {"name":"건물","cost":{"cur":1457946280,"pri":1457946280},
     "acc_dep":{"cur":-613359386,"pri":-540462072},"no_dep":false,"status":"ok","note":""},
    {"name":"토지","cost":{"cur":3991177596,"pri":3776457596},
     "acc_dep":null,"no_dep":true,"status":"exception","note":"감가상각누계액 없음"}
  ],
  "printed_total":{"cur":7767880534,"pri":6173278378}
}

[income_statement / manufacturing_cost 모드]
표준 품목 16개로 매핑한다:
원재료비, 연료비, 전력비, 용수비(수도비), 외주가공비(위탁생산비),
수선비(수리유지비), 급여총액, 퇴직급여, 복리후생비, 임차료, 세금과공과,
감가상각비, 대손상각비, 경상연구개발비, 광고선전비, 운반·하역·보관비
- 이 문서가 income_statement 이면 추출값을 각 품목의 "pl" 에 넣고 "cogm"=null.
  manufacturing_cost 이면 "cogm" 에 넣고 "pl"=null.
- 명칭 매핑/예외:
  · 용수비(수도비) ← '가스수도료'  → status="exception", note="원문 '가스수도료', 가스 포함"
  · 급여총액 ← 급여+임금+잡급 합산  → status="exception", note="급여+임금+잡급 합산"
    (income_statement=급여+잡급, manufacturing_cost=급여+임금)
  · 운반·하역·보관비 ← '운반비'만   → status="exception", note="운반비만 반영, 하역·보관 제외"
  · 퇴직급여는 급여총액에 합치지 말 것(별도)
  · 연료비←연료비/유류비, 전력비←전력비/동력비,
    외주가공비←외주가공비/외주비/임가공비, 수선비←수선비/수리비,
    임차료←임차료/지급임차료, 세금과공과←세금과공과금/제세공과금,
    경상연구개발비←경상개발비/연구개발비, 광고선전비←광고선전비/광고비
  · 문서에 없는 항목은 null + status="review"
- 추가 2칸: extras.손익계산서_판관비(=판관비 합계), extras.영업이익. (income_statement 에서)
- 명칭이 표준과 정확히 일치/명확하면 status="ok". 잘리거나 흐리면 status="review".
- 출력 형태:
{
  "doc_type":"income_statement","company_raw":"...","company_key":"...",
  "fiscal":{"current":"제29기","prior":"제28기"},"unit":"원",
  "items":[ {"name":"원재료비","pl":null,"cogm":null,"total":null,"status":"ok","note":""}, ... 16개 ],
  "extras":{"손익계산서_판관비":734913280,"영업이익":864121367}
}

[출력] 위 형식의 JSON만 출력. 설명·마크다운·코드펜스 절대 금지.`;

interface ParseBody {
  image?: string | null;
  // 하위호환(이전 단일 호출 방식)도 허용
  pl_image?: string | null;
  cogm_image?: string | null;
}

function toImageBlock(input: string): Anthropic.ImageBlockParam | null {
  if (!input) return null;
  let mediaType = "image/jpeg";
  let data = input;
  const m = input.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]*)$/);
  if (m) {
    mediaType = m[1];
    data = m[2];
  }
  data = data.trim();
  if (!data) return null;
  const allowed = ["image/jpeg", "image/png", "image/gif", "image/webp"];
  if (!allowed.includes(mediaType)) mediaType = "image/jpeg";
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: mediaType as
        | "image/jpeg"
        | "image/png"
        | "image/gif"
        | "image/webp",
      data,
    },
  };
}

function stripCodeFence(text: string): string {
  let t = text.trim();
  const fence = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) t = fence[1].trim();
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) t = t.slice(first, last + 1);
  return t;
}

export async function POST(req: Request) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      {
        error:
          "서버에 ANTHROPIC_API_KEY 가 설정되지 않았습니다. .env.local 을 확인하세요.",
      },
      { status: 500 }
    );
  }

  let body: ParseBody;
  try {
    body = (await req.json()) as ParseBody;
  } catch {
    return NextResponse.json(
      { error: "잘못된 요청(JSON 파싱 실패)." },
      { status: 400 }
    );
  }

  const imageInput = body.image || body.pl_image || body.cogm_image;
  const block = imageInput ? toImageBlock(imageInput) : null;
  if (!block) {
    return NextResponse.json(
      { error: "이미지가 없습니다." },
      { status: 400 }
    );
  }

  const anthropic = new Anthropic({ apiKey });

  let rawText = "";
  try {
    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            block,
            {
              type: "text",
              text: "이 이미지를 분류하고 지정 JSON 스키마로만 출력하라. 산수는 하지 말 것.",
            },
          ],
        },
      ],
    });
    rawText = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");
  } catch (err: any) {
    const detail = err?.message || "알 수 없는 오류";
    return NextResponse.json(
      { error: `Anthropic API 호출 실패: ${detail}` },
      { status: 502 }
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(rawText));
  } catch {
    return NextResponse.json(
      {
        error: "AI 응답을 JSON으로 파싱하지 못했습니다.",
        raw: rawText.slice(0, 2000),
      },
      { status: 502 }
    );
  }

  return NextResponse.json(normalizeDoc(parsed));
}
