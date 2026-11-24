# NVIDIA NIM Model Catalog Benchmark — CueScript Gen AI Analysis & Recommendations

**Tested Date:** 2026-11-24  
**Endpoint:** `https://integrate.api.nvidia.com/v1`  
**Total Catalog Models Discovered:** 32 (16 Chat / Multimodal LLMs tested + 16 Specialized Utility Models)  
**Test Inputs Used:**
- **Image Attachment Test:** `public/ATF60Stocks.jpg` (base64 JPEG via `image_url`)
- **Transcript Cross-Reference:** Hindi/English sample transcript testing ATF #1 (`Cipla`), ATF #2 (`Manappuram Finance`), ATF #31 (`Solar Industries`), and outside-ATF stocks/ETFs (`NVIDIA`, `S&P 500`, `QQQ`)
- **Full 60-Stock OCR Stress Test:** Extracting all 60 numbered stocks from `public/ATF60Stocks.jpg`
- **File Attachment Tests:** Inline `type: "file"` (`.txt`, `.md`, `.pdf`), `type: "document"`, `POST /v1/files`, `POST /v1/responses`, and NVIDIA NVCF Assets (`/v2/nvcf/assets`)
- **JSON Output Test:** Structured JSON generation for Recommendations synthesis

---

## 1. Document & File Attachment Support (All Models)

| Attachment Mechanism | Result Across Catalog | Details |
| :--- | :--- | :--- |
| Image (`image_url` base64 JPEG/PNG) | **Supported** (Vision models only) | Works cleanly on multimodal models (`ATF60Stocks.jpg` readable). |
| Inline `type: "file"` (`.txt`, `.md`, `.pdf`) | **Not Supported** | Returns `HTTP 422: input rejected by content safety screening` (multimodal models) or `HTTP 400: Failed to deserialize` (text-only models). |
| Inline `type: "document"` | **Not Supported** | Returns `HTTP 422: input rejected by content safety screening`. |
| `POST /v1/files` | **Not Supported** | Returns `HTTP 404 page not found`. |
| `POST /v1/responses` | **Not Supported** | Returns `HTTP 404 page not found`. |
| `POST https://api.nvcf.nvidia.com/v2/nvcf/assets` | **Not Supported** | Returns `HTTP 410 Gone`. |

**Takeaway:** None of the models on `https://integrate.api.nvidia.com/v1` accept `.txt`, `.md`, or `.pdf` file attachments. `ATF60Stocks.jpg` can be sent as an `image_url` attachment, while `.txt` transcripts and `analysis.md` contents must be passed as text inside `messages`. (Google Gemini Files API remains the only provider in CueScript with native `.txt`/`.md` file uploads.)

---

## 2. Benchmark Results — All 16 Chat / Multimodal LLMs

### A. Vision-Capable Models (Usable for Gen AI Analysis + Recommendations)

| Model | Free Key Status | Text + JSON | Small Vision (`ATF60Stocks.jpg` + Hindi/Eng) | Full 60-Stock OCR Stress Test | File Attachments | Notes |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **`z-ai/glm-5.3-flash`** | Works | OK (8.6s, JSON OK, reasoning) | **OK — 4/4 (9.9s)** | **PASSED — 60/60 stocks (26.6s, TTFB 3.5s)** | No (422) | **Best overall for Gen AI Analysis.** Only NVIDIA model to complete full 60-stock OCR accurately without timing out (`#1 Cipla` through `#60 IndusInd Bank`). |
| **`minimaxai/minimax-m3.1-flash`** | Works | OK (7.8s, JSON OK, reasoning) | **OK — 4/4 (4.1s)** | Timed out (65s) | No (422) | Fastest on short vision prompts, but stalls on full 60-stock extraction. |
| **`nvidia/nemotron-3-nano-omni-30b-a3b-reasoning`** | Works | OK (2.7s, JSON OK, reasoning) | **OK — 4/4 (7.2s)** | Timed out (65s) | No (422) | Good short vision accuracy; timed out on full 60-stock OCR. |
| **`nvidia/nemotron-3.5-super-vl-120b-a12b`** | Works | OK (24.6s, JSON OK, reasoning) | **OK — 4/4 (20.5s)** | Timed out (65s) | No (422) | Accurate on small vision prompts, slow latency, timed out on 60-stock OCR. |
| **`stepfun-ai/step-5-preview`** | Works | OK (1.7s, JSON OK, reasoning) | ~7.1s (3 stocks only); timed out (60s–65s) with transcript | Timed out (65s) | No (422) | Heavy reasoning overhead causes frequent timeouts on image + transcript prompts. |
| **`mistralai/mistral-large-4-1t-a52b`** | Works (streaming) | OK (0.9s short / 14.2s JSON streaming; timed out non-streaming) | Timed out (55s) | Timed out (55s) | No (422) | Fast text streaming; vision timed out at 55s. |
| **`nvidia/nemotron-3.5-bolt-e4b`** | Works | OK (0.6s, JSON OK, non-reasoning) | Timed out (65s) | Not reached | No (422) | Very fast lightweight text model; vision timed out. |
| **`meta/muse-glimmer-30b`** | Works | OK (22.7s, JSON OK, reasoning) | Timed out (65s) | Not reached | No (422) | Slow text response; vision timed out. |

### B. Text-Only Working Models (Usable for Recommendations Only — No Image Input)

| Model | Free Key Status | Text + JSON | Vision (`image_url`) | File Attachments | Notes |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **`nvidia/nemotron-3-ultra-550b-a55b`** | Works | **OK (2.9s, JSON OK, reasoning)** | Not enabled (400) | No (400) | **Top candidate for Recommendations** — 550B reasoning flagship, fast (~2.9s), valid structured JSON. |
| **`nvidia/nemotron-3.5-lightning-30b-a3b`** | Works | OK (2.9s, JSON OK, reasoning) | Not enabled (400) | No (400) | Fast text reasoning model. |
| **`poolside/laguna-xs-2.1`** | Works | OK (0.6s, JSON OK, non-reasoning) | Not enabled (400) | No (400) | Fastest text model tested (617ms). |

### C. Unavailable or Timed-Out Models on This API Key

| Model | Status | Error Observed |
| :--- | :--- | :--- |
| `google/gemma-3-4b-it` | Unavailable | `HTTP 404: Function not found for account` |
| `google/gemma-3-12b-it` | Unavailable | `HTTP 404: Function not found for account` |
| `nvidia/cosmos-reason2-8b` | Unavailable | `HTTP 404: Function not found for account` |
| `google/gemma-4-31b-it` | Unreachable / Timed out | Timed out at 35s on both non-streaming and streaming text requests |
| `moonshotai/kimi-k3.1-pro` | Unreachable / Timed out | Timed out at 35s on both non-streaming and streaming text requests |

---

## 3. Remaining 16 Specialized Utility Models in Catalog (Not General Chat LLMs)

These were excluded from the chat/multimodal benchmark because they are specialized embedding, safety, PII, translation, video detection, or code-completion models:

- **Code Completion:** `bigcode/starcoder2-15b`
- **Embeddings / Retrieval:** `nvidia/embed-qa-4`, `nvidia/llama-3.2-nemoretriever-1b-vlm-embed-v1`, `nvidia/llama-3.2-nv-embedqa-1b-v1`, `nvidia/nemotron-3.5-embed-1b`, `nvidia/nemotron-3.5-embed-8b`, `nvidia/nv-embedqa-mistral-7b-v2`, `nvidia/nvclip`, `snowflake/arctic-embed-l`
- **Safety / Guardrails / Calibration:** `nvidia/llama-3.1-nemoguard-8b-topic-control`, `nvidia/llama-3.1-nemotron-safety-guard-8b-v3`, `nvidia/nemotron-3.5-content-safety`, `nvidia/ising-calibration-1.5-31b`
- **PII / Translation / Video Detection:** `fastino/gliner2-pii`, `nvidia/riva-translate-4b-instruct-v2`, `nvidia/ai-synthetic-video-detector`

---

## 4. Recommended Model Routing for CueScript

### Gen AI Analysis (Requires Vision + Full 60-Stock OCR + Hindi/English Reasoning)
1. **Primary:** `z-ai/glm-5.3-flash` via NVIDIA NIM (streaming enabled, 180s timeout) — only catalog model that accurately extracted all 60/60 stocks from `ATF60Stocks.jpg` without timing out.
2. **Secondary:** Google Gemini (`gemini-4-hydrogen` / `gemini-3.1-flash-lite`) via Gemini Files API (supports native `.txt` + image attachments).
3. **Tertiary (Last Fallback):** OpenAI-compatible (`gpt-5.4-2026-03-05`).

### Recommendations (Text-Only `.md` Consolidation → Structured JSON)
1. **Primary:** `nvidia/nemotron-3-ultra-550b-a55b` (550B reasoning, ~2.9s, clean JSON) — *or* `z-ai/glm-5.3-flash` for a unified single-model setup.
2. **Secondary:** Google Gemini (`gemini-4-hydrogen` / `gemini-3.1-flash-lite`).
3. **Tertiary (Last Fallback):** OpenAI-compatible (`gpt-5.4-2026-03-05`).

### Configuration Note
Store the NVIDIA key in environment variable `NVIDIA_API_KEY` (documented in `.env.example`, configured in **Settings > Secrets**) rather than hardcoding credentials in source code.
