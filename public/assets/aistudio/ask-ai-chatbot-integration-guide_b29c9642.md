# Ask AI Chatbot — Complete Architecture & Integration Guide

> **Audience:** Anyone — including developers or product builders who have **never worked with AI APIs** and know **nothing about this app** — who wants to understand how the **Ask AI / Deep Dive Assistant** works and drop the exact same chatbot into any other application.

---

## Table of Contents

1. [Plain-English Overview (No AI Background Needed)](#1-plain-english-overview-no-ai-background-needed)
2. [High-Level Architecture](#2-high-level-architecture)
3. [Models, Providers & API Details (Current App)](#3-models-providers--api-details-current-app)
4. [Exact HTTP Requests & Responses](#4-exact-http-requests--responses)
5. [How the Conversation Works (Initial Summary & Follow-Ups)](#5-how-the-conversation-works-initial-summary--follow-ups)
6. [How Images Are Sent Alongside Data (Multimodal Binding)](#6-how-images-are-sent-alongside-data-multimodal-binding)
7. [UI Component Deep Dive (`InsightChatbot.tsx`)](#7-ui-component-deep-dive-insightchatbottsx)
8. [How Data Is Fed In (All 4 Integration Points in This App)](#8-how-data-is-fed-in-all-4-integration-points-in-this-app)
9. [Step-by-Step: Integrate Ask AI Into Any Other App](#9-step-by-step-integrate-ask-ai-into-any-other-app)
10. [Non-React / Vanilla JS & cURL Examples](#10-non-react--vanilla-js--curl-examples)
11. [Customization & Best Practices](#11-customization--best-practices)
12. [Troubleshooting & Known Quirks in the Current Codebase](#12-troubleshooting--known-quirks-in-the-current-codebase)

---

## 1. Plain-English Overview (No AI Background Needed)

Before looking at code, here are the **5 simple concepts** behind how any AI chatbot works:

1. **What is an AI Model (LLM)?**  
   Think of an AI model (like GPT or Gemini) as a remote web service — just like a weather API or payment API. You send it text (and optionally images) in a JSON HTTP `POST` request, and it replies with generated text.

2. **AI APIs Have No Memory ("Stateless")**  
   Every time you ask a follow-up question, the AI server starts completely fresh with **zero memory** of what you asked 5 seconds ago. To make a chat feel continuous, **your app** must send the entire conversation history (plus the original data context) on every single request.

3. **Message Roles (`system`, `user`, `assistant`/`model`)**  
   Every message in the array you send to the AI has a `role`:
   - **`system`** (or `systemInstruction`): Permanent rules & persona for the AI (e.g., *"You are a senior financial assistant. Use bullet points and bold headers."*). The user never sees this.
   - **`user`**: Messages sent *to* the AI — including hidden data dumps and the questions the human types.
   - **`assistant`** (OpenAI format) or **`model`** (Gemini format): Previous replies generated *by* the AI.

4. **Context Injection ("Grounding")**  
   An AI does not automatically know what is on the user's screen. To let it analyze your app's cards, tables, or posts, your app converts that screen data into JSON text (`JSON.stringify(contextData)`) and pastes it into the prompt sent to the AI.

5. **Context Size Limit (Truncation)**  
   AI models have a maximum input size. To prevent giant payloads from failing, this app safely trims the JSON context to **30,000 characters** (`.substring(0, 30000)`).

---

## 2. High-Level Architecture

In this app, **Ask AI** is built around **two core frontend files** plus **4 host screens** that pass data into it:

| Layer | File in Current App | Responsibility |
| :--- | :--- | :--- |
| **Host Screens (Data Feeders)** | `BulkInsightManager.tsx`, `StockDeepDive.tsx`, `IntelligentTrackingManager.tsx`, `MarketNewsTab.tsx` | Collect selected cards/records/posts, normalize the data into a clean array (`contextData`), and open the chatbot. |
| **Chat UI & Conversation Manager** | `fe/components/TrackingDashboard/InsightChatbot.tsx` | Renders the floating chat drawer, auto-triggers the initial summary, maintains visible chat history, re-injects context + images on every follow-up turn. |
| **AI Transport Service** | `fe/services/geminiService.ts` (`getChatResponse`) | Formats messages for the active AI provider (`proxy` or `gemini`), attaches system rules & images, calls the API over HTTP, and returns plain text (or a safe fallback error string). |
| **Types** | `fe/types/trackingTypes.ts` (`ChatMessage`) | Defines `{ id: string; role: 'user' | 'model'; text: string; timestamp: number }`. |

### End-to-End Flow Diagram

```text
┌────────────────────────────────────────────────────────────────────────────┐
│  1. USER CLICKS "Ask AI" OR "Analyze Selected (N)"                         │
│     Host screen builds: contextData = [ { symbol, indicator, data }, ... ] │
│     (Optional) analysisPrompt = "Custom instructions..."                   │
└────────────────────────────────────┬───────────────────────────────────────┘
                                     │ passes props: contextData, analysisPrompt, onClose
                                     ▼
┌────────────────────────────────────────────────────────────────────────────┐
│  2. <InsightChatbot /> MOUNTS (Bottom-Right Floating Widget)               │
│     • Extracts unique image URLs -> contextImages[]                        │
│     • Strips raw image URLs from text JSON -> stripImageUrls(contextData)  │
│     • useEffect() fires automatically (Turn 1 - no typing required!)       │
└────────────────────────────────────┬───────────────────────────────────────┘
                                     │ calls getChatResponse(history, message, images)
                                     ▼
┌────────────────────────────────────────────────────────────────────────────┐
│  3. geminiService.ts -> getChatResponse()                                  │
│     Checks ACTIVE_PROVIDER:                                                │
│       ├─ 'proxy' (CURRENT DEFAULT)                                         │
│       │    Prepends system prompt, converts role 'model' -> 'assistant',   │
│       │    attaches image_url blocks, POSTs to:                            │
│       │    ${PROXY_URL}/chat/completions  (OpenAI-compatible JSON API)     │
│       └─ 'gemini' (ALTERNATIVE)                                            │
│            Calls @google/genai SDK (ai.chats.create -> chat.sendMessage)   │
│            with REST fetch fallback if SDK fails                           │
└────────────────────────────────────┬───────────────────────────────────────┘
                                     │ returns AI response text (string)
                                     ▼
┌────────────────────────────────────────────────────────────────────────────┐
│  4. <InsightChatbot /> RENDERS RESPONSE                                    │
│     • Appends { role: 'model', text } to messages[]                        │
│     • Formats **bold** segments via renderText(), preserves line breaks    │
│     • Auto-scrolls to bottom                                               │
│     • On follow-up question: rebuilds [context anchor + all prior turns]   │
│       + new question + contextImages[] and calls getChatResponse() again   │
└────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Models, Providers & API Details (Current App)

All AI configuration lives at the top of `fe/services/geminiService.ts`:

```ts
type AIProvider = 'proxy' | 'gemini';
const ACTIVE_PROVIDER: AIProvider = 'proxy';
const PROXY_URL = import.meta.env.VITE_AI_PROXY_URL || 'https://apps.mrcoder.buzz/gpt/v1';
const AI_MODEL = import.meta.env.VITE_AI_MODEL || 'gpt-5.4-2026-03-05';
const GEMINI_MODEL_NAME = "gemini-2.5-flash-lite";
```

### Provider Comparison

| Setting | Active Mode: `'proxy'` (Default) | Alternative Mode: `'gemini'` |
| :--- | :--- | :--- |
| **How it is enabled** | `ACTIVE_PROVIDER = 'proxy'` (currently active in code) | Change `ACTIVE_PROVIDER = 'gemini'` in `geminiService.ts` |
| **Model Used** | `gpt-5.4-2026-03-05` (or `VITE_AI_MODEL` env var) | `gemini-2.5-flash-lite` |
| **API Protocol** | OpenAI-compatible Chat Completions REST API | Google `@google/genai` SDK (`^1.35.0`) + direct REST fallback |
| **Endpoint URL** | `POST ${PROXY_URL}/chat/completions` <br>Default: `https://apps.mrcoder.buzz/gpt/v1/chat/completions` | Primary: `@google/genai` SDK<br>Fallback: `POST https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=<API_KEY>` |
| **Authentication** | None in request header (proxy handles auth server-side; for standard OpenAI/OpenRouter, add `Authorization: Bearer <KEY>`) | API key read from `localStorage.getItem('GEMINI_API_KEY')` (configured via **API Settings** modal in `ConfigurationView.tsx`) |
| **Streaming** | Disabled (`stream: false`) — waits for complete response | Disabled — waits for complete response |
| **Image Support in Chat** | **Yes** — attaches `image_url` parts on every turn | **No** in current `getChatResponse` implementation (text-only) |
| **Environment Variables** | `VITE_AI_PROXY_URL`, `VITE_AI_MODEL` (defined in `.env.example`) | Optional `GEMINI_API_KEY` (or browser `localStorage`) |

---

## 4. Exact HTTP Requests & Responses

### A. Active Provider (`'proxy'` — OpenAI-Compatible Format)

This is the exact payload sent by `callProxyChat()` in `fe/services/geminiService.ts`.

#### 1. Text-Only Request

```http
POST https://apps.mrcoder.buzz/gpt/v1/chat/completions
Content-Type: application/json
```

*(Note: When integrating with OpenAI, OpenRouter, Groq, or your own authenticated gateway, also include `Authorization: Bearer YOUR_API_KEY`.)*

```json
{
  "model": "gpt-5.4-2026-03-05",
  "stream": false,
  "messages": [
    {
      "role": "system",
      "content": "You are a senior financial assistant. Answer questions based on provided data context.\n\nIMPORTANT FORMATTING RULES:\n1. Use bullet points for lists.\n2. Use **bold** for key metrics or headers.\n3. Keep paragraphs short and readable.\n4. If data is missing, clearly state it."
    },
    {
      "role": "user",
      "content": "\n        Context Data Provided: [{\"symbol\":\"RELIANCE\",\"indicator\":\"PE\",\"data\":{\"tiles\":[...]}}]\n\n        Action: Please analyze the provided financial data (PE, Holdings, Deals, etc.) and provide a comprehensive summary.\n        - Format the output nicely with bold headers and bullet points.\n        - Highlight risks and opportunities.\n        - If the data is raw HTML or unreadable, try to extract numbers and sentiments.\n      "
    }
  ]
}
```

#### 2. Multimodal Request (When `contextData` Contains Images)

When `images.length > 0`, two things change automatically:
1. The `system` message appends instructions telling the model to inspect attached images and match `"imageRef": "Image N"` to the N-th attached image.
2. The latest `user` message's `content` becomes an **array of content blocks** instead of a string:

```json
{
  "model": "gpt-5.4-2026-03-05",
  "stream": false,
  "messages": [
    {
      "role": "system",
      "content": "You are a senior financial assistant. ... \n\nIMPORTANT - ATTACHED IMAGES: Images are attached inline to the user messages in this conversation. You MUST look at each attached image and use its visual content in your answer before responding. A post's \"imageRef\" (e.g. \"Image 2\") names the attached image it owns. Never claim you cannot see images."
    },
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "Context Data Provided: [{\"id\":1,\"date\":\"2026-09-20\",\"text\":\"...\",\"imageRef\":\"Image 1\"}]\n\nAction: ..."
        },
        {
          "type": "image_url",
          "image_url": {
            "url": "https://example.com/chart-1.png"
          }
        }
      ]
    }
  ]
}
```

#### 3. Expected JSON Response

```json
{
  "id": "chatcmpl-...",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "**Valuation Summary**\n- **Current PE:** 22.4 vs Sector PE 19.44...\n\n**Key Risks**\n- ..."
      },
      "finish_reason": "stop"
    }
  ]
}
```

The app extracts the reply with:
```ts
return data.choices?.[0]?.message?.content || '';
```

---

### B. Alternative Provider (`'gemini'` — Google GenAI SDK + REST Fallback)

When `ACTIVE_PROVIDER === 'gemini'`:

1. **Primary (SDK):**
   ```ts
   const chat = ai.chats.create({
     model: "gemini-2.5-flash-lite",
     history: history, // Array of { role: 'user' | 'model', parts: [{ text: string }] }
     config: {
       systemInstruction: "You are a senior financial assistant..."
     }
   });
   const result = await chat.sendMessage({ message });
   return result.text;
   ```
2. **Fallback (Direct REST `fetch` if SDK throws):**
   ```http
   POST https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=YOUR_API_KEY
   Content-Type: application/json
   ```
   ```json
   {
     "contents": [
       {
         "parts": [
           { "text": "You are a senior financial assistant...\n\nHistory:\nUser: ...\nModel: ...\n\nUser: <new question>\nModel:" }
         ]
       }
     ]
   }
   ```
   Response extraction: `data.candidates?.[0]?.content?.parts?.[0]?.text || ''`.

---

## 5. How the Conversation Works (Initial Summary & Follow-Ups)

This is the most important pattern to understand if you want to replicate **Ask AI** cleanly.

### Phase 1: Automatic Initial Summary (Turn 1)

When `<InsightChatbot contextData={...} />` renders, a React `useEffect` immediately runs `initChat()` **without waiting for the user to type anything**:

1. Sets `loading = true` (displays the animated 3-dot bubble).
2. Strips raw `image` URLs from `contextData` (so JSON stays compact) and truncates to `30,000` characters.
3. Combines the JSON context + `analysisPrompt` (or the default financial summary prompt) into a `hiddenPrompt`.
4. Calls `getChatResponse([], hiddenPrompt, contextImages)`.
   - Notice `history` is `[]` (empty) on Turn 1.
   - Notice `hiddenPrompt` is **NOT** added to `messages` state — so the user never sees a giant raw JSON wall in the chat window.
5. Saves only the AI's reply into `messages`:
   ```ts
   setMessages([{
     id: 'welcome-analysis',
     role: 'model',
     text: response,
     timestamp: Date.now()
   }]);
   ```

### Phase 2: Handling Follow-Up Questions (Turn 2, Turn 3, ...)

When the user types a follow-up question (e.g., *"Is PE overvalued compared to sector?"*) and presses **Enter** or clicks **Send**:

1. The user's message is immediately added to the visible UI `messages` list and `input` is cleared.
2. Because the API is **stateless**, `handleSend()` constructs a complete `history` array containing:
   - **Synthetic Anchor Turn 1 (`role: 'user'`)**: Re-injects the original `contextData` JSON (`"Here is the data context you must strictly stick to..."`).
   - **Synthetic Anchor Turn 2 (`role: 'model'`)**: `"Understood. I will answer based strictly on the provided financial context."` *(This alternating user/model pair is required by strict chat APIs like Gemini and keeps the model grounded.)*
   - **All Previous Visible Messages**: Every previous summary, user question, and AI answer already in `messages`.
3. Calls `getChatResponse(history, userMsg.text, contextImages)`:
   - Note that in React, `messages` inside `handleSend` still holds all turns *before* `userMsg`, while `userMsg.text` is appended at the very end as the latest user message.
   - `contextImages` are **re-attached** on every follow-up turn so the model can still see the images if the user asks *"What does the chart in post 2 show?"*
4. Inside `getChatResponse`, if using `'proxy'`, role names are automatically mapped:
   - `'model'` → `'assistant'`
   - `'user'` → `'user'`
5. The AI's new reply is appended to `messages` as `{ role: 'model', text: response }`.

### Visual Timeline of What Is Sent on Each Turn

```text
TURN 1 (Auto-Analysis on Open)
  Sent to API:
    [0] system    : Persona + Formatting rules (+ Image instructions if images exist)
    [1] user      : "Context Data Provided: <JSON> \n Action: <analysisPrompt>" [+ images]
  Shown in UI:
    • Model Bubble: "<Initial AI Summary>"

TURN 2 (User asks: "What are the biggest risks?")
  Sent to API:
    [0] system    : Persona + Formatting rules (+ Image instructions if images exist)
    [1] user      : "Here is the data context you must strictly stick to: <JSON>"
    [2] assistant : "Understood. I will answer based strictly on the provided financial context."
    [3] assistant : "<Initial AI Summary>"
    [4] user      : "What are the biggest risks?" [+ images]
  Shown in UI:
    • Model Bubble: "<Initial AI Summary>"
    • User Bubble : "What are the biggest risks?"
    • Model Bubble: "<Risk Analysis Reply>"

TURN 3 (User asks: "Summarize in 2 bullet points")
  Sent to API:
    [0] system    : Persona + Formatting rules
    [1] user      : "Here is the data context you must strictly stick to: <JSON>"
    [2] assistant : "Understood..."
    [3] assistant : "<Initial AI Summary>"
    [4] user      : "What are the biggest risks?"
    [5] assistant : "<Risk Analysis Reply>"
    [6] user      : "Summarize in 2 bullet points" [+ images]
```

> **Integration Tip:** Notice that on Turn 2, indices `[2]` and `[3]` are both `assistant` messages in a row (`"Understood..."` followed by the initial welcome analysis). OpenAI-compatible APIs allow consecutive assistant messages, whereas some stricter APIs (like Anthropic Claude or strict Gemini validators) prefer strictly alternating `user` / `assistant` turns. In our clean reusable code in **Section 9**, we show how to avoid consecutive assistant turns by pairing the initial welcome summary with a synthetic `"Analyze this data"` user turn so it works on **every** LLM provider!

---

## 6. How Images Are Sent Alongside Data (Multimodal Binding)

When analyzing items that have associated images (like **Market News / Community Posts** in `communityPostsService.ts`), sending raw URLs inside JSON text doesn't allow the AI to *see* the images. Instead, this app uses a clean **3-step binding pattern**:

1. **Assign Explicit Labels When Building Context (`buildAnalysisContext`)**:
   ```ts
   // fe/services/communityPostsService.ts
   posts.slice(0, 30).forEach((p, i) => {
     const item: any = {
       id: i + 1,
       date: p.parsedDate.toISOString().split('T')[0],
       text: p.contentText,
     };
     if (p.imageUrl) {
       images.push(p.imageUrl);
       item.imageRef = `Image ${images.length}`; // e.g., "Image 1", "Image 2"
       item.image = p.imageUrl;                  // Extracted by InsightChatbot
     }
     items.push(item);
   });
   ```

2. **Separate Image URLs From Text in `InsightChatbot.tsx`**:
   - `contextImages` collects all unique `item.image` URLs in exact order.
   - `stripImageUrls(contextData)` removes the `image` key from every JSON item before stringifying, **keeping** `imageRef: "Image 1"`.
   - This prevents wasting tokens on long image URLs while preserving an exact link between each text record and its image.

3. **Attach Images as Native Multimodal Parts (`geminiService.ts`)**:
   - The `images[]` array is appended to the user message as `{ type: 'image_url', image_url: { url } }`.
   - The system prompt instructs the model: *"A post's `imageRef` (e.g. `Image 2`) names the attached image it owns."*

---

## 7. UI Component Deep Dive (`InsightChatbot.tsx`)

### Component Props Contract

```ts
interface InsightChatbotProps {
  contextData: any[];       // Required: Array of objects/records for the AI to analyze
  onClose: () => void;      // Required: Called when user clicks the X button
  analysisPrompt?: string;  // Optional: Custom initial analysis prompt (overrides default)
}
```

### Visual Anatomy & Behavior

| UI Section | Implementation Details |
| :--- | :--- |
| **Floating Container** | Fixed at bottom-right (`fixed bottom-4 right-4 z-50`), rounded card (`rounded-2xl shadow-2xl border border-gray-200`). Smoothly animates between compact (`w-[400px] h-[600px]`) and expanded (`w-[800px] h-[80vh]`). |
| **Header Bar** | Indigo background (`bg-indigo-600 text-white`). Displays `<Bot />` icon, title **"Deep Dive Assistant"**, item count badge (`{contextData.length} Items`), Expand/Minimize button (`Maximize2` / `Minimize2`), and Close button (`X`). |
| **Message Feed** | Scrollable area (`flex-1 overflow-y-auto bg-gray-50`). User messages align right (`bg-indigo-600 text-white rounded-br-none`); AI messages align left (`bg-white border text-gray-800 rounded-bl-none`). Uses `whitespace-pre-wrap` to keep line breaks and bullet lists intact. |
| **Text Formatting** | Lightweight zero-dependency helper `renderText(text)` splits on `/(\*\*.*?\*\*)/g` to turn `**text**` into `<strong>text</strong>`. |
| **Loading Indicator** | While `loading === true`, renders an AI-aligned bubble with 3 bouncing indigo dots (`animate-bounce` with staggered `delay-75`, `delay-150`). |
| **Auto-Scroll** | Invisible `<div ref={messagesEndRef} />` at the bottom of the feed; `useEffect` calls `messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })` whenever `messages` or `loading` updates. |
| **Input Bar** | Text input (`placeholder="Ask follow up questions..."`) supporting **Enter** key submission (`onKeyDown`), paired with an indigo Send button disabled whenever `loading || !input.trim()`. |

---

## 8. How Data Is Fed In (All 4 Integration Points in This App)

The exact same `<InsightChatbot />` component is reused across **4 completely different views** in the app simply by passing different shapes of `contextData` (and optionally a custom `analysisPrompt`).

### Integration Point 1: Tracked Assets — Multi-Card Selection (`BulkInsightManager.tsx`)
*Shown in Screenshot 1 (`Analyze Selected (2)` button).*

1. Each card (`BaseInsightCard.tsx`) has a checkbox in its top-right header.
2. `BulkInsightManager` tracks checked cards in `selectedCards: Set<string>` using keys like `"RELIANCE|PE"` and `"RELIANCE|DetailledPE"`.
3. When `selectedCards.size > 0`, an indigo **`Analyze Selected (N)`** button appears in the toolbar.
4. Clicking it builds an array of selected card payloads (resolving nested Next.js JSON for `FinancialInsights` and `DetailledPE`) and passes it up via `onOpenChat(selectedData)` to `TrackingDashboard.tsx`, which mounts `<InsightChatbot />`:
   ```ts
   // BulkInsightManager.tsx
   const handleAnalyzeSelection = () => {
     const selectedData: any[] = [];
     selectedCards.forEach(key => {
       const [sym, ind] = key.split('|');
       const item = results[sym]?.find(i => i.indicatorName === ind);
       if (item) {
         selectedData.push({
           symbol: sym,
           indicator: ind,
           data: ind === 'FinancialInsights'
             ? resolveFinancialsData(item.data)
             : ind === 'DetailledPE'
             ? resolveKeyMetricsData(item.data)
             : item.data
         });
       }
     });
     if (selectedData.length > 0) onOpenChat(selectedData);
   };
   ```

### Integration Point 2: Stock Deep Dive — Whole-Stock Analysis (`StockDeepDive.tsx`)
*Shown in Screenshots 2 & 3 (`Ask AI` button → `Deep Dive Assistant 8 Items`).*

1. Displays all indicator cards for a single stock (e.g., Reliance Industries Ltd).
2. The header contains an indigo **`Ask AI`** button whenever `stockResults.length > 0`.
3. Clicking it packages **every** loaded indicator for that stock and mounts `<InsightChatbot />` locally:
   ```tsx
   // StockDeepDive.tsx
   <button
     onClick={(e) => {
       e.stopPropagation();
       setChatContext(
         stockResults.map(i => ({
           symbol,
           indicator: i.indicatorName,
           data: i.indicatorName === 'FinancialInsights'
             ? resolveFinancialsData(i.data)
             : i.indicatorName === 'DetailledPE'
             ? resolveKeyMetricsData(i.data)
             : i.data
         }))
       );
     }}
   >
     <MessageSquare size={16} /> Ask AI
   </button>

   {chatContext && (
     <InsightChatbot contextData={chatContext} onClose={() => setChatContext(null)} />
   )}
   ```

### Integration Point 3: Intelligent Tracking — Single Card Triggered Insights (`IntelligentTrackingManager.tsx` & `IntelligentStockCard.tsx`)
1. Each stock summary card displays an **`Ask AI`** button in its card footer.
2. Clicking it passes the pre-filtered triggered insights (`Valuation`, `Technicals`, `Holdings`, `Performance`, `Deals`) along with their underlying raw data:
   ```ts
   onAskAI={() => onOpenChat(
     insights.map((i) => ({
       symbol,
       type: String(i.type || ''),
       insight: String(i.text || ''),
       rawData: i.data
     }))
   )}
   ```

### Integration Point 4: Market News — Multimodal Posts + Custom Prompt (`MarketNewsTab.tsx` & `communityPostsService.ts`)
1. Users filter community posts by time range and search query.
2. Clicking **`Ask AI`** calls `buildAnalysisContext(filteredPosts)` (capped at `30` posts) which structures `{ id, date, text, imageRef?, image? }`.
3. Calls `onOpenChat(items, POSTS_ANALYSIS_PROMPT)` — demonstrating how to override the default financial summary prompt with a domain-specific prompt (`Summary`, `Stocks & Markets`, `Recommendations & Concepts`, `Action Items & Portfolio`).

### Summary Matrix of All 4 Integration Points

| Screen | Trigger Button | `contextData` Item Shape | Custom `analysisPrompt`? | Includes Images? |
| :--- | :--- | :--- | :--- | :--- |
| **Tracked Assets** | `Analyze Selected (N)` | `{ symbol, indicator, data }` | No (uses default) | No |
| **Stock Deep Dive** | `Ask AI` | `{ symbol, indicator, data }` (all indicators) | No (uses default) | No |
| **Intelligent Tracking** | Card footer `Ask AI` | `{ symbol, type, insight, rawData }` | No (uses default) | No |
| **Market News** | Filter bar `Ask AI` | `{ id, date, text, imageRef?, image? }` | Yes (`POSTS_ANALYSIS_PROMPT`) | Yes |

---

## 9. Step-by-Step: Integrate Ask AI Into Any Other App

Follow these **5 steps** to drop this exact **Ask AI** chatbot into **any React + Tailwind web app** (e.g., an e-commerce dashboard, CRM, HR portal, healthcare app, or analytics tool).

### Prerequisites

Install icons (the only UI dependency besides React and Tailwind CSS):

```bash
npm install lucide-react
```

*(Optional: If calling Google Gemini directly from Node/Browser, install `npm install @google/genai`.)*

---

### Step 1: Set Up a Secure Backend Proxy Route (Strongly Recommended)

> **Why?** Never put secret API keys (`OPENAI_API_KEY`, `GEMINI_API_KEY`) directly inside browser frontend code — anyone can open DevTools and steal them. Also, calling external AI APIs directly from the browser often triggers CORS errors. Instead, create one tiny backend endpoint (`/api/ai/chat`) and have your frontend call that!

#### Example: Node.js + Express Backend Route (`server/routes/aiChat.js`)

Works with **OpenAI**, **OpenRouter**, **Groq**, **Azure OpenAI**, **Google Gemini's OpenAI-compatible endpoint** (`https://generativelanguage.googleapis.com/v1beta/openai`), or your own custom proxy (`https://apps.mrcoder.buzz/gpt/v1`):

```js
// server/routes/aiChat.js
import express from 'express';

const router = express.Router();

// Configure via environment variables (.env)
const AI_BASE_URL = process.env.AI_BASE_URL || 'https://api.openai.com/v1';
const AI_API_KEY = process.env.AI_API_KEY || '';
const AI_MODEL = process.env.AI_MODEL || 'gpt-4o-mini';

router.post('/chat', async (req, res) => {
  try {
    const { messages, model } = req.body;

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array is required' });
    }

    const headers = { 'Content-Type': 'application/json' };
    if (AI_API_KEY) {
      headers['Authorization'] = `Bearer ${AI_API_KEY}`;
    }

    const upstream = await fetch(`${AI_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: model || AI_MODEL,
        messages,
        stream: false,
      }),
    });

    if (!upstream.ok) {
      const errBody = await upstream.json().catch(() => ({}));
      return res.status(upstream.status).json({
        error: errBody.error?.message || `Upstream AI error (${upstream.status})`,
      });
    }

    const data = await upstream.json();
    const reply = data.choices?.[0]?.message?.content || '';
    return res.json({ reply });
  } catch (err) {
    console.error('AI Chat Proxy Error:', err);
    return res.status(500).json({ error: 'Failed to reach AI service' });
  }
});

export default router;
```

**Environment variables (`.env`) examples for popular providers:**

```env
# Option A: OpenAI
AI_BASE_URL=https://api.openai.com/v1
AI_API_KEY=sk-...
AI_MODEL=gpt-4o-mini

# Option B: Google Gemini (via Gemini's official OpenAI-compatible endpoint!)
AI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai
AI_API_KEY=AIza...
AI_MODEL=gemini-2.5-flash

# Option C: Custom OpenAI-compatible Proxy (same as current app)
AI_BASE_URL=https://apps.mrcoder.buzz/gpt/v1
AI_API_KEY=
AI_MODEL=gpt-5.4-2026-03-05
```

> **Pro Tip:** Because Google Gemini natively supports the OpenAI Chat Completions format at `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`, this **one** backend route lets you swap between OpenAI, Gemini, Claude (via OpenRouter), Groq, or a local Ollama server just by changing 3 lines in `.env` — zero code changes required!

---

### Step 2: Create the Frontend AI Chat Service (`src/services/aiChatService.ts`)

Copy this file into your target app. It mirrors `getChatResponse` from this app, including multimodal image attachment and clean error handling.

```ts
// src/services/aiChatService.ts

export interface ChatHistoryTurn {
  role: 'user' | 'assistant';
  text: string;
}

type MessageContent =
  | string
  | Array<
      | { type: 'text'; text: string }
      | { type: 'image_url'; image_url: { url: string } }
    >;

const CHAT_ENDPOINT = import.meta.env.VITE_CHAT_API_URL || '/api/ai/chat';

const DEFAULT_SYSTEM_PROMPT = `You are a helpful, accurate data analyst assistant. Answer questions strictly based on the provided data context.

IMPORTANT FORMATTING RULES:
1. Use bullet points for lists.
2. Use **bold** for key metrics or headers.
3. Keep paragraphs short and readable.
4. If requested data is missing from the context, clearly state that it is not available.`;

export async function getAIChatResponse(options: {
  history: ChatHistoryTurn[];
  message: string;
  images?: string[];
  systemPrompt?: string;
}): Promise<string> {
  const { history, message, images = [], systemPrompt } = options;
  const hasImages = images.length > 0;

  const finalSystemPrompt =
    (systemPrompt || DEFAULT_SYSTEM_PROMPT) +
    (hasImages
      ? '\n\nIMPORTANT - ATTACHED IMAGES: Images are attached inline to the user message. Inspect each attached image and use its visual content in your answer. An item\'s "imageRef" (e.g. "Image 2") matches the N-th attached image.'
      : '');

  const latestUserContent: MessageContent = hasImages
    ? [
        { type: 'text', text: message },
        ...images.map((url) => ({
          type: 'image_url' as const,
          image_url: { url },
        })),
      ]
    : message;

  const messages = [
    { role: 'system', content: finalSystemPrompt },
    ...history.map((turn) => ({
      role: turn.role,
      content: turn.text,
    })),
    { role: 'user', content: latestUserContent },
  ];

  const response = await fetch(CHAT_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || `AI request failed (${response.status})`);
  }

  const data = await response.json();
  // Supports both our custom { reply } backend and direct OpenAI { choices } responses
  return data.reply ?? data.choices?.[0]?.message?.content ?? '';
}
```

---

### Step 3: Copy the Reusable Chatbot Component (`src/components/AskAIChatbot.tsx`)

This is a clean, self-contained version of `InsightChatbot.tsx` ready for any React + Tailwind app. It fixes the consecutive-assistant-turn edge case and supports customizable titles and system prompts.

```tsx
// src/components/AskAIChatbot.tsx
import React, { useState, useEffect, useRef, useMemo } from 'react';
import { X, Send, Bot, Maximize2, Minimize2 } from 'lucide-react';
import { getAIChatResponse, ChatHistoryTurn } from '../services/aiChatService';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  timestamp: number;
}

export interface AskAIChatbotProps {
  /** Array of records/cards/items to feed to the AI */
  contextData: any[];
  /** Callback when user clicks close (X) */
  onClose: () => void;
  /** Header title (default: "AI Assistant") */
  title?: string;
  /** Optional custom instruction for the automatic first-turn summary */
  analysisPrompt?: string;
  /** Optional custom system persona/rules */
  systemPrompt?: string;
  /** Max characters of JSON context to send (default: 30000) */
  maxContextChars?: number;
}

const DEFAULT_ANALYSIS_PROMPT = `Please analyze the provided data and give a clear, comprehensive summary.
- Format the output with **bold** headers and bullet points.
- Highlight key insights, patterns, risks, and actionable takeaways.`;

const AskAIChatbot: React.FC<AskAIChatbotProps> = ({
  contextData,
  onClose,
  title = 'AI Assistant',
  analysisPrompt,
  systemPrompt,
  maxContextChars = 30000,
}) => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // 1. Extract unique image URLs in deterministic order (for multimodal requests)
  const contextImages = useMemo(
    () => [
      ...new Set(
        contextData
          .filter((item) => item && typeof item === 'object' && typeof item.image === 'string' && item.image)
          .map((item) => item.image as string)
      ),
    ],
    [contextData]
  );

  // 2. Strip raw image URLs from text JSON (keep imageRef labels if present)
  const serializedContext = useMemo(() => {
    const textSafeItems = contextData.map((item) => {
      if (item && typeof item === 'object' && 'image' in item) {
        const { image, ...rest } = item;
        return rest;
      }
      return item;
    });
    return JSON.stringify(textSafeItems).substring(0, maxContextChars);
  }, [contextData, maxContextChars]);

  // 3. Auto-run Turn 1 analysis whenever contextData changes
  useEffect(() => {
    if (contextData.length === 0) return;

    let cancelled = false;
    const initChat = async () => {
      setMessages([]);
      setLoading(true);

      const actionBlock = analysisPrompt ?? DEFAULT_ANALYSIS_PROMPT;
      const hiddenPrompt = `Context Data Provided:\n${serializedContext}\n\nAction:\n${actionBlock}`;

      try {
        const reply = await getAIChatResponse({
          history: [],
          message: hiddenPrompt,
          images: contextImages,
          systemPrompt,
        });

        if (!cancelled) {
          setMessages([
            {
              id: 'welcome-analysis',
              role: 'assistant',
              text: reply || "I've loaded the data but couldn't generate a summary. Ask me anything!",
              timestamp: Date.now(),
            },
          ]);
        }
      } catch (err) {
        console.error('Initial AI analysis failed:', err);
        if (!cancelled) {
          setMessages([
            {
              id: 'init-error',
              role: 'assistant',
              text: "I'm having trouble connecting to the analysis engine right now. Please try again.",
              timestamp: Date.now(),
            },
          ]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    initChat();
    return () => {
      cancelled = true;
    };
  }, [serializedContext, contextImages, analysisPrompt, systemPrompt, contextData.length]);

  // 4. Auto-scroll to latest message
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  // 5. Handle follow-up questions (stateless full-history re-injection)
  const handleSend = async () => {
    const trimmed = input.trim();
    if (!trimmed || loading) return;

    const userMsg: ChatMessage = {
      id: Date.now().toString(),
      role: 'user',
      text: trimmed,
      timestamp: Date.now(),
    };

    const previousMessages = messages;
    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    setLoading(true);

    try {
      // Strictly alternating history:
      // Turn 1 (user): original data context + initial instruction
      // Turn 2+ (assistant/user/...): all prior visible conversation turns
      const history: ChatHistoryTurn[] = [
        {
          role: 'user',
          text: `Here is the data context you must strictly stick to (any attached images are part of this context; an item's "imageRef" names its image):\n${serializedContext}\n\nPlease summarize this data first, then answer my follow-up questions.`,
        },
        ...previousMessages.map((m) => ({
          role: m.role,
          text: m.text,
        })),
      ];

      const reply = await getAIChatResponse({
        history,
        message: trimmed,
        images: contextImages, // Re-attach images on every follow-up turn
        systemPrompt,
      });

      setMessages((prev) => [
        ...prev,
        {
          id: (Date.now() + 1).toString(),
          role: 'assistant',
          text: reply || "I couldn't generate a response.",
          timestamp: Date.now(),
        },
      ]);
    } catch (err) {
      console.error('Follow-up AI error:', err);
      setMessages((prev) => [
        ...prev,
        {
          id: (Date.now() + 1).toString(),
          role: 'assistant',
          text: "I'm having trouble connecting to the analysis engine right now. Please try again.",
          timestamp: Date.now(),
        },
      ]);
    } finally {
      setLoading(false);
    }
  };

  // Lightweight **bold** formatter (replace with react-markdown if you need tables/headings)
  const renderText = (text: string) =>
    text.split(/(\*\*.*?\*\*)/g).map((part, i) =>
      part.startsWith('**') && part.endsWith('**') ? (
        <strong key={i}>{part.slice(2, -2)}</strong>
      ) : (
        part
      )
    );

  return (
    <div
      className={`fixed bottom-4 right-4 bg-white rounded-2xl shadow-2xl border border-gray-200 flex flex-col transition-all duration-300 z-50 ${
        isExpanded ? 'w-[800px] max-w-[95vw] h-[80vh]' : 'w-[400px] max-w-[95vw] h-[600px]'
      }`}
    >
      {/* Header */}
      <div className="p-4 bg-indigo-600 text-white rounded-t-2xl flex items-center justify-between shadow-sm">
        <div className="flex items-center gap-2">
          <Bot size={20} />
          <span className="font-semibold">{title}</span>
          <span className="bg-indigo-500 px-2 py-0.5 rounded text-xs text-indigo-100">
            {contextData.length} {contextData.length === 1 ? 'Item' : 'Items'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="hover:bg-indigo-500 p-1 rounded"
            title={isExpanded ? 'Compact view' : 'Expand view'}
          >
            {isExpanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          </button>
          <button
            onClick={onClose}
            className="hover:bg-indigo-500 p-1 rounded"
            title="Close"
          >
            <X size={18} />
          </button>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-gray-50">
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className={`max-w-[85%] rounded-2xl p-3 text-sm whitespace-pre-wrap leading-relaxed ${
                msg.role === 'user'
                  ? 'bg-indigo-600 text-white rounded-br-none'
                  : 'bg-white border border-gray-200 text-gray-800 rounded-bl-none shadow-sm'
              }`}
            >
              {renderText(msg.text)}
            </div>
          </div>
        ))}

        {loading && (
          <div className="flex justify-start">
            <div className="bg-white border border-gray-200 rounded-2xl rounded-bl-none p-3 shadow-sm">
              <div className="flex gap-1">
                <div className="w-2 h-2 bg-indigo-400 rounded-full animate-bounce" />
                <div className="w-2 h-2 bg-indigo-400 rounded-full animate-bounce delay-75" />
                <div className="w-2 h-2 bg-indigo-400 rounded-full animate-bounce delay-150" />
              </div>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="p-4 border-t border-gray-100 bg-white rounded-b-2xl">
        <div className="flex gap-2">
          <input
            type="text"
            className="flex-1 border border-gray-300 rounded-xl px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
            placeholder="Ask follow up questions..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSend()}
          />
          <button
            onClick={handleSend}
            disabled={loading || !input.trim()}
            className="bg-indigo-600 text-white p-2 rounded-xl hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            title="Send"
          >
            <Send size={18} />
          </button>
        </div>
      </div>
    </div>
  );
};

export default AskAIChatbot;
```

---

### Step 4: Wire It Up in Your Page (3 Copy-Paste Recipes)

#### Recipe A: Single-Page "Ask AI" Button (Like Stock Deep Dive)

```tsx
import React, { useState } from 'react';
import { MessageSquare } from 'lucide-react';
import AskAIChatbot from './components/AskAIChatbot';

export function OrderDetailPage({ order, lineItems, customerHistory }) {
  const [chatContext, setChatContext] = useState<any[] | null>(null);

  const handleOpenAI = () => {
    setChatContext([
      { section: 'Order Summary', data: order },
      { section: 'Line Items', data: lineItems },
      { section: 'Customer History', data: customerHistory },
    ]);
  };

  return (
    <div>
      <button
        onClick={handleOpenAI}
        className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg"
      >
        <MessageSquare size={16} /> Ask AI
      </button>

      {chatContext && (
        <AskAIChatbot
          title="Order Analyst"
          contextData={chatContext}
          onClose={() => setChatContext(null)}
        />
      )}
    </div>
  );
}
```

#### Recipe B: Multi-Select Cards + "Analyze Selected (N)" (Like Tracked Assets)

```tsx
import React, { useState } from 'react';
import { MessageSquare } from 'lucide-react';
import AskAIChatbot from './components/AskAIChatbot';

export function ProductGrid({ products }) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [chatContext, setChatContext] = useState<any[] | null>(null);

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const handleAnalyzeSelected = () => {
    const chosen = products.filter((p) => selectedIds.has(p.id));
    if (chosen.length > 0) setChatContext(chosen);
  };

  return (
    <div>
      {selectedIds.size > 0 && (
        <button
          onClick={handleAnalyzeSelected}
          className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg"
        >
          <MessageSquare size={16} /> Analyze Selected ({selectedIds.size})
        </button>
      )}

      <div className="grid grid-cols-3 gap-4 mt-4">
        {products.map((product) => (
          <div key={product.id} className="border p-4 rounded-xl">
            <input
              type="checkbox"
              checked={selectedIds.has(product.id)}
              onChange={() => toggleSelect(product.id)}
            />
            <h3>{product.name}</h3>
            <p>${product.price}</p>
          </div>
        ))}
      </div>

      {chatContext && (
        <AskAIChatbot
          title="Product Comparison Assistant"
          contextData={chatContext}
          analysisPrompt="Compare the selected products on price, value, and key differences. Recommend the best choice."
          onClose={() => setChatContext(null)}
        />
      )}
    </div>
  );
}
```

#### Recipe C: Feeding Items With Images + Custom Prompt (Like Market News)

```tsx
const buildContextWithImages = (posts) => {
  let imageIndex = 0;
  return posts.slice(0, 20).map((post, idx) => {
    const item: any = {
      id: idx + 1,
      date: post.createdAt,
      text: post.body,
    };
    if (post.screenshotUrl) {
      imageIndex += 1;
      item.imageRef = `Image ${imageIndex}`; // Kept in JSON text
      item.image = post.screenshotUrl;       // Automatically extracted & attached by AskAIChatbot
    }
    return item;
  });
};

// Trigger:
setChatContext(buildContextWithImages(filteredPosts));
```

---

## 10. Non-React / Vanilla JS & cURL Examples

If your other app uses **Vue, Angular, Svelte, Python, PHP, mobile, or plain HTML/JS**, the exact same stateless conversation pattern applies.

### Vanilla JavaScript (Any Web App)

```js
// Store conversation state in memory
const contextData = [{ name: "Widget A", revenue: 120000, margin: "24%" }];
const conversationHistory = [];

// Turn 1: Initial Summary
async function startAnalysis() {
  const initialPrompt = `Context Data Provided:\n${JSON.stringify(contextData)}\n\nAction: Summarize key highlights with bullet points.`;

  const res = await fetch('/api/ai/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [
        { role: 'system', content: 'You are a concise business analyst. Use **bold** headers and bullet points.' },
        { role: 'user', content: initialPrompt }
      ]
    })
  });

  const { reply } = await res.json();
  conversationHistory.push({ role: 'user', content: initialPrompt });
  conversationHistory.push({ role: 'assistant', content: reply });
  return reply;
}

// Turn 2+: Follow-up Question
async function askFollowUp(question) {
  conversationHistory.push({ role: 'user', content: question });

  const res = await fetch('/api/ai/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [
        { role: 'system', content: 'You are a concise business analyst. Use **bold** headers and bullet points.' },
        ...conversationHistory
      ]
    })
  });

  const { reply } = await res.json();
  conversationHistory.push({ role: 'assistant', content: reply });
  return reply;
}
```

### Quick Test via `curl`

```bash
curl -X POST https://api.openai.com/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "model": "gpt-4o-mini",
    "stream": false,
    "messages": [
      {
        "role": "system",
        "content": "You are a helpful data analyst. Answer strictly from the provided JSON context."
      },
      {
        "role": "user",
        "content": "Context: [{\"symbol\":\"RELIANCE\",\"pe\":22.4,\"sectorPe\":19.44}]\n\nAction: Summarize valuation in 2 bullets."
      }
    ]
  }'
```

---

## 11. Customization & Best Practices

1. **Trim Data Before Passing It In**  
   Don't dump raw HTML, massive arrays, or unneeded UI metadata into `contextData`. Pick only the meaningful fields (like `symbol`, `indicator`, `metrics`, `date`, `text`). Smaller context = faster responses, lower cost, and higher accuracy.
2. **Prevent Accidental Re-Runs in React**  
   Because `useEffect` watches `contextData`, make sure you only call `setChatContext([...])` when the user clicks **"Ask AI"** (not inline on every render), otherwise the chat will reset on parent re-renders.
3. **Upgrade Markdown Rendering (Optional)**  
   The current `renderText()` only handles `**bold**` and newlines. If you want tables, headings (`###`), links, and code blocks, install `react-markdown` and replace `{renderText(msg.text)}` with `<ReactMarkdown>{msg.text}</ReactMarkdown>`.
4. **Add Streaming Later (Optional)**  
   Right now `stream: false` waits for the full answer (typically 2–8 seconds). For long reports, you can switch to `stream: true` using Server-Sent Events (`ReadableStream`) to show words typing out live.
5. **Security Checklist**
   - Always keep API keys in backend environment variables (`.env`), never in frontend bundles or `localStorage` in production.
   - Add rate limiting on your `/api/ai/chat` backend route so one user cannot exhaust your API quota.
   - Validate request body size on the backend (e.g., cap `messages` length and character count).

---

## 12. Troubleshooting & Known Quirks in the Current Codebase

### Why Did Screenshot 3 Show `"I'm having trouble connecting to the analysis engine right now. Please try again."`?

That exact message comes from line 476 of `fe/services/geminiService.ts`:

```ts
try {
  return await callProxyChat(messages);
} catch (e) {
  console.error("AI proxy chat error", e);
  return "I'm having trouble connecting to the analysis engine right now. Please try again.";
}
```

When you see that message, open your browser's **DevTools → Network / Console** tab and check these 5 common causes:

| Cause | What You'll See in DevTools | How to Fix |
| :--- | :--- | :--- |
| **1. Proxy server is unreachable / down** | `net::ERR_CONNECTION_REFUSED` or `502 / 503 / 504` on `https://apps.mrcoder.buzz/gpt/v1/chat/completions` | Verify `PROXY_URL` is online, or point `VITE_AI_PROXY_URL` to your own backend `/api/ai/chat` route. |
| **2. CORS blocked by browser** | `Access to fetch at '...' has been blocked by CORS policy` | Route requests through your own backend server instead of calling a third-party AI endpoint directly from the browser. |
| **3. Wrong or deprecated model name** | `400` or `404` (`model not found`) | Update `VITE_AI_MODEL` (e.g., `gpt-4o-mini` or `gemini-2.5-flash`) to a model supported by your endpoint. |
| **4. Missing / invalid API key** | `401 Unauthorized` or `429 Quota Exceeded` | Check your API key & billing/rate limits on your provider dashboard. |
| **5. Oversized payload or broken image URL** | `400 Bad Request` or `413 Payload Too Large` | Reduce `maxContextChars` (e.g., from `30000` to `15000`) or ensure image URLs are publicly reachable HTTPS URLs (or base64 data URIs). |

### Notable Quirks in the Current App Codebase (Good to Know)

1. **API Settings Modal vs. Active Provider**: The app has an **"API Settings"** button in `ConfigurationView.tsx` that saves a Google Gemini API key to `localStorage`. However, because `ACTIVE_PROVIDER` in `fe/services/geminiService.ts` is currently hardcoded to `'proxy'`, changing the Gemini key in UI Settings has **no effect** unless `ACTIVE_PROVIDER` is changed to `'gemini'`.
2. **Image Support Only in `'proxy'` Mode**: In `fe/services/geminiService.ts`, `images` passed to `getChatResponse()` are only attached inside the `if (ACTIVE_PROVIDER === 'proxy')` branch. If switching to `'gemini'`, update that branch to send inline image parts as well.
3. **Unused `history` Variable in `InsightChatbot.tsx`**: Lines 61–66 of `InsightChatbot.tsx` define a local `history` array during `initChat` that isn't passed to `getChatResponse([], hiddenPrompt, images)` — safe to ignore/remove when porting.
4. **Silent `catch` in `handleSend`**: `InsightChatbot.tsx`'s `handleSend` relies on `getChatResponse` returning a string on error rather than throwing; in the reusable component in **Section 9**, both error paths display a clear error bubble to the user.
