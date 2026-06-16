# 재무제표 파싱 웹툴

손익계산서·제조원가명세서 사진을 업로드하면 표준 16개 품목 + 추가 2칸으로
매핑하고 `합산 = 손익 + 제조원가`를 계산해 모바일 한 화면에 보여주는 내부용 도구.

## 스택

- Next.js 14 (App Router) 단독. 별도 백엔드/DB 없음 (stateless).
- AI 파싱: `/api/parse` 서버 라우트에서 Anthropic Vision(`claude-sonnet-4-6`) 호출.
- 스타일: Tailwind, 모바일 우선(viewport ≈ 380px).

## 실행

```bash
npm install
cp .env.local.example .env.local   # 그리고 ANTHROPIC_API_KEY 채우기
npm run dev
```

- `ANTHROPIC_API_KEY` 는 **서버 측 `.env.local` 에만** 둔다. 클라이언트에서 직접
  Anthropic API 를 부르지 않는다(키 노출 금지).

## 사용

1. 상단 업로드 영역 2개(손익계산서 / 제조원가명세서)에 사진 선택. 한쪽만 올려도 됨.
2. **분석** → 결과 표 렌더.
3. 각 행의 `손익`/`제조` 셀을 탭해 수정하면 `합산`이 자동 재계산.
4. 표 아래 "확인 필요 항목" 영역에 ⚠️(예외)·❓(검토) 사유가 한 줄씩 표시됨.

## 배지

- ✅ 확인됨 · ⚠️ 예외(원문 명칭이 표준과 다름) · ❓ 검토필요(잘림/저해상도/항목 없음 등)

## 구조

- `app/page.tsx` — 업로드 UI + 결과 표 + 셀 편집 + 하단 설명
- `app/api/parse/route.ts` — Vision 호출, JSON 파싱, 정규화
- `lib/schema.ts` — 표준 품목 순서, 타입, total 재계산, 응답 정규화
