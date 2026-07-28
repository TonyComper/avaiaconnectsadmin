/**
 * metg-functions/functions/index.js  (GEN 2)
 *
 * ✅ LIVE endpoints (HTTPS):
 * - createOpenRequest     (called by VAPI)
 * - acceptRequest         (called by dashboard)
 * - setRequestComment     (called by dashboard)
 * - archiveRequest        (called by dashboard)
 * - setUserHotelMap       (admin/setup - protect/remove after setup)
 *
 * ✅ Hotel Memory:
 * - rebuildProblemRooms (manual HTTP) => /hotels/{hotelCode}/memory/problemRooms
 * - buildProblemRoomsAllHotels (scheduled) => runs nightly for all hotels
 *
 * ✅ Hotel Insights (LLM):
 * - rebuildProblemRoomInsights (manual HTTP) =>
 *      /hotels/{hotelCode}/insights/problemRoomInsights (selected window)
 *      /hotels/{hotelCode}/insights/problemRoomInsightsTrend30d (always 30d trend)
 *      /hotels/{hotelCode}/insights/problemRooms        (back-compat)
 * - buildProblemRoomInsightsAllHotels (scheduled) => runs nightly for all hotels
 *
 * ✅ Translation (Choice A):
 * - Translates requestText into multiple languages at CREATE time
 *
 * ✅ Category Drilldown (LLM):
 * - rebuildCategoryInsights (manual HTTP) =>
 *      /hotels/{hotelCode}/insights/categoryInsights/{range}/{categorySlug}
 *
 * ✅ Reputation (Phase 1):
 * - setHotelReputationConfig
 * - syncSerpReviewsForHotel
 * - rebuildReputationPhase1
 * - getReputationPhase1
 *
 * ✅ Reputation (Phase 2):
 * - rebuildReputationPhase2
 * - getReputationPhase2
 * - buildReputationPhase2AllHotels (scheduled)
 *
 * 🔐 Secrets (GEN 2):
 *   firebase functions:secrets:set OPENAI_API_KEY
 *   firebase functions:secrets:set SERPAPI_API_KEY
 *   firebase functions:secrets:set GOOGLE_PLACES_API_KEY
 *   firebase deploy --only functions
 *
 * NOTE:
 * This file intentionally uses fetch() to call OpenAI.
 * ✅ No "client" variable is used anywhere (fixes: "client is not defined").
 */

const slugify = require("slugify");
const admin = require("firebase-admin");
const axios = require("axios");
const {
  classifyRestaurantComplaintText,
} = require("./lib/reputation/classifyRestaurantComplaint");
const {
  RESTAURANT_COMPLAINT_TAXONOMY,
} = require("./lib/reputation/restaurantComplaintTaxonomy");
const { defineSecret } = require("firebase-functions/params");
const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { getUberEatsSource } = require("./lib/getUberEatsSource");
const { fetchUberEatsReviews } = require("./lib/fetchUberEatsReviews");
const { waitForApifyRun } = require("./lib/waitForApifyRun");
const { getApifyDatasetItems } = require("./lib/getApifyDatasetItems");
const { getNormalizedUberEatsReviews } = require("./lib/getNormalizedUberEatsReviews");
const crypto = require("crypto");
const { normalizeUberEatsReviews } = require("./lib/normalizeUberEatsReviews");
const { parseOpenTableUrl } = require("./lib/parseOpenTableUrl");
const cors = require("cors")({ origin: true });

if (!admin.apps.length) admin.initializeApp();
const db = admin.database();
const auth = admin.auth();

// ✅ Firebase Secrets (do NOT hardcode any key in code)
const OPENAI_API_KEY = defineSecret("OPENAI_API_KEY");
const GOOGLE_PLACES_API_KEY = defineSecret("GOOGLE_PLACES_API_KEY");
const SERPAPI_API_KEY = defineSecret("SERPAPI_API_KEY");

// Languages your staff UI supports
const TARGET_LANGS = ["en", "es", "fr", "it", "pt", "ru", "zh", "ko"];

/* --------------------------- Helpers --------------------------- */

function safeTrim(v) {
  return (v ?? "").toString().trim();
}

function normalizeHotelCode(v) {
  return safeTrim(v).toLowerCase();
}

function coerceLang(lang) {
  const l = safeTrim(lang).toLowerCase();
  return l || "en";
}

function setCors(res) {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
}

function formatLocalIso(date, timeZone) {
  const formatted = new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);

  return formatted.replace(" ", "T");
}

function toMs(ts) {
  if (ts == null) return null;

  if (typeof ts === "number") return ts < 2_000_000_000 ? ts * 1000 : ts;

  if (typeof ts === "string") {
    const s = ts.trim();
    if (!s) return null;

    const n = Number(s);
    if (!Number.isNaN(n)) return n < 2_000_000_000 ? n * 1000 : n;

    const parsed = Date.parse(s);
    return Number.isNaN(parsed) ? null : parsed;
  }

  return null;
}

function stripJsonFences(s) {
  const t = safeTrim(s);
  if (!t) return "";
  return t.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
}

function getRoomNumberFromRecord(r) {
  const v =
    r?.roomNumber ??
    r?.room ??
    r?.roomNo ??
    r?.room_number ??
    r?.roomnum ??
    "";
  const s = safeTrim(v);
  if (!s) return "";
  const m = s.match(/\d+/);
  return m ? m[0] : s;
}

function toMsFromRecord(r) {
  return toMs(r?.createdAtMs) ?? toMs(r?.createdAt) ?? null;
}

function resolveMsFromRecord(r) {
  return toMs(r?.acceptedAtMs) ?? toMs(r?.acceptedAt) ?? null;
}

function clamp(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.min(Math.max(x, min), max);
}

function normalizeText(s) {
  return safeTrim(s).toLowerCase();
}

function pickQuote(text, maxLen = 240) {
  const t = safeTrim(text).replace(/\s+/g, " ");
  if (t.length <= maxLen) return t;
  return t.slice(0, maxLen - 1) + "…";
}

function dayKeyFromMs(ms, timeZone = "UTC") {
  try {
    // en-CA => YYYY-MM-DD
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

/**
 * Very small topic extractor for memory summaries.
 * You can expand this list anytime.
 */
function extractRequestTopic(r) {
  const cat = safeTrim(r?.category || "OTHER").toLowerCase();
  const text =
    safeTrim(r?.requestOriginal) ||
    safeTrim(r?.requestTranslated?.en) ||
    safeTrim(r?.requestText) ||
    "";

  const t = `${cat} ${text}`.toLowerCase();

  if (/(extra|additional|more)\s+pillows?|\bpillows?\b/.test(t)) return "pillows";
  if (/(extra|additional|more)\s+towels?|\btowels?\b/.test(t)) return "towels";
  if (/(blanket|blankets)/.test(t)) return "blankets";
  if (/(toothbrush|toothpaste|razor|shower cap|amenit|toiletr)/.test(t)) return "toiletries";
  if (/(tv|remote)/.test(t)) return "tv/remote";
  if (/(ac|air\s*conditioning|heater|thermostat|too hot|too cold)/.test(t)) return "hvac";
  if (/(noise|loud|neighbor)/.test(t)) return "noise";
  if (/(late\s*check|checkout)/.test(t)) return "late checkout";
  if (/(ice|ice bucket)/.test(t)) return "ice";
  if (/(plates|cutlery|fork|spoon|knife|wine glass|corkscrew|bottle opener|cups)/.test(t))
    return "dining items";

  if (cat) return `category:${cat}`;
  return "other";
}

/* --------------------------- OpenAI Utilities --------------------------- */

async function openaiJson({ apiKey, model, prompt, reasoningEffort = "low" }) {
  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      reasoning: { effort: reasoningEffort },
      input: prompt,
      text: { verbosity: "medium" },
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`openai_http_${resp.status}: ${errText.slice(0, 300)}`);
  }

  const data = await resp.json();

  const outText =
    data?.output_text ||
    (Array.isArray(data?.output)
      ? data.output
          .flatMap((o) => o?.content || [])
          .map((c) => (c?.type === "output_text" ? c.text : ""))
          .join("")
      : "");

  const raw = safeTrim(outText);
  const cleaned = stripJsonFences(raw);

  try {
    return JSON.parse(cleaned);
  } catch {
    throw new Error(`openai_json_parse_failed: ${cleaned.slice(0, 250)}`);
  }
}

async function generateInsightsJson({ apiKey, prompt, model = "gpt-5.2", effort = "medium" }) {
  if (!apiKey) {
    return { ok: false, parseOk: false, parseSample: "missing_openai_key", json: null };
  }

  try {
    const resp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        reasoning: { effort },
        input: prompt,
        text: { verbosity: "medium" },
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return { ok: false, parseOk: false, parseSample: errText.slice(0, 220), json: null };
    }

    const data = await resp.json();

    const outText =
      data?.output_text ||
      (Array.isArray(data?.output)
        ? data.output
            .flatMap((o) => o?.content || [])
            .map((c) => (c?.type === "output_text" ? c.text : ""))
            .join("")
        : "");

    const raw = safeTrim(outText);
    const cleaned = stripJsonFences(raw);

    try {
      const parsed = JSON.parse(cleaned);
      return { ok: true, parseOk: true, parseSample: cleaned.slice(0, 220), json: parsed };
    } catch {
      return { ok: false, parseOk: false, parseSample: cleaned.slice(0, 220), json: null };
    }
  } catch (e) {
    return { ok: false, parseOk: false, parseSample: String(e).slice(0, 220), json: null };
  }
}

/* --------------------------- Translation --------------------------- */

async function translateAll({ requestText, sourceLang, apiKey }) {
  const src = coerceLang(sourceLang);
  const text = safeTrim(requestText);

  if (!apiKey || !text) {
    const fallback = {};
    fallback[src] = text;
    return {
      originalLanguage: src,
      requestOriginal: text,
      requestTranslated: fallback,
      translationMeta: {
        ok: false,
        reason: !apiKey ? "missing_openai_key" : "empty_text",
      },
    };
  }

  const prompt = [
    "You are a translation engine for hotel guest requests.",
    "Return ONLY valid minified JSON (no markdown, no extra text).",
    `Output must be an object with exactly these keys: ${TARGET_LANGS.join(", ")}.`,
    "Translate naturally for hotel staff. Keep it short.",
    "",
    `Source language: ${src}`,
    `Request: ${text}`,
  ].join("\n");

  try {
    const resp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-5.2",
        reasoning: { effort: "low" },
        input: prompt,
        text: { verbosity: "medium" },
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      const fallback = {};
      fallback[src] = text;
      return {
        originalLanguage: src,
        requestOriginal: text,
        requestTranslated: fallback,
        translationMeta: {
          ok: false,
          reason: `openai_http_${resp.status}`,
          detail: errText.slice(0, 300),
        },
      };
    }

    const data = await resp.json();

    const outText =
      data?.output_text ||
      (Array.isArray(data?.output)
        ? data.output
            .flatMap((o) => o?.content || [])
            .map((c) => (c?.type === "output_text" ? c.text : ""))
            .join("")
        : "");

    const raw = safeTrim(outText);

    let parsed;
    try {
      parsed = JSON.parse(stripJsonFences(raw));
    } catch {
      const fallback = {};
      fallback[src] = text;
      return {
        originalLanguage: src,
        requestOriginal: text,
        requestTranslated: fallback,
        translationMeta: { ok: false, reason: "json_parse_failed", sample: raw.slice(0, 200) },
      };
    }

    const requestTranslated = {};
    for (const k of TARGET_LANGS) requestTranslated[k] = safeTrim(parsed?.[k]) || "";

    requestTranslated[src] = requestTranslated[src] || text;
    requestTranslated.en = requestTranslated.en || text;

    return {
      originalLanguage: src,
      requestOriginal: text,
      requestTranslated,
      translationMeta: { ok: true },
    };
  } catch (err) {
    const fallback = {};
    fallback[src] = text;
    return {
      originalLanguage: src,
      requestOriginal: text,
      requestTranslated: fallback,
      translationMeta: { ok: false, reason: "exception", detail: String(err).slice(0, 200) },
    };
  }
}

/* --------------------------- Requests Read (LIVE + ARCHIVED) --------------------------- */

async function readAllHotelRequests(hotelCode) {
  const liveSnap = await db.ref(`hotels/${hotelCode}/requests`).get();
  const live = liveSnap.val() || {};

  const archSnap = await db.ref(`hotels/${hotelCode}/archivedRequests`).get();
  const archived = archSnap.val() || {};

  const rows = [];

  for (const [id, data] of Object.entries(live)) rows.push({ id, source: "live", data: data || {} });
  for (const [id, data] of Object.entries(archived)) rows.push({ id, source: "archived", data: data || {} });

  return rows;
}

/* --------------------------- Memory Builder: Problem Rooms --------------------------- */

async function buildProblemRoomsForHotel(hotelCodeRaw, { windowDays = 30 } = {}) {
  const hotelCode = normalizeHotelCode(hotelCodeRaw);

  const nowMs = Date.now();
  const windowMs = windowDays * 24 * 60 * 60 * 1000;
  const cutoffMs = nowMs - windowMs;

  const rows = await readAllHotelRequests(hotelCode);

  let totalRequestsScanned = 0;
  let withRoomNumber = 0;
  let missingRoomNumber = 0;
  let missingCreatedAtMs = 0;

  let lastRequestAtMs = 0;

  const byRoom = new Map();

  for (const row of rows) {
    const r = row.data || {};
    totalRequestsScanned++;

    const room = getRoomNumberFromRecord(r);
    if (!room) {
      missingRoomNumber++;
      continue;
    }
    withRoomNumber++;

    const createdMs = toMsFromRecord(r);
    if (!createdMs) {
      missingCreatedAtMs++;
      continue;
    }

    if (createdMs > lastRequestAtMs) lastRequestAtMs = createdMs;

    if (createdMs < cutoffMs) continue;

    const status = safeTrim(r.status || "OPEN").toUpperCase();
    if (status !== "OPEN" && status !== "ACCEPTED") continue;

    const category = safeTrim(r.category || "OTHER").toUpperCase() || "OTHER";
    const topic = extractRequestTopic(r);

    const resolvedMs = resolveMsFromRecord(r);
    const isResolved = status === "ACCEPTED" && resolvedMs && resolvedMs >= createdMs;
    const resolveMinutes = isResolved ? (resolvedMs - createdMs) / 60000 : null;

    if (!byRoom.has(room)) {
      byRoom.set(room, {
        roomNumber: room,
        requestCount30d: 0,
        repeatCategories14d: {},
        recurrenceCount72h: 0,
        resolveTimes: [],
        lastSeenMs: 0,
        lastRequestMs: 0,
        topicCounts30d: {},
      });
    }

    const s = byRoom.get(room);

    s.requestCount30d++;
    s.lastRequestMs = Math.max(s.lastRequestMs, createdMs);

    const cutoff14 = nowMs - 14 * 24 * 60 * 60 * 1000;
    if (createdMs >= cutoff14) s.repeatCategories14d[category] = (s.repeatCategories14d[category] || 0) + 1;

    if (s.lastSeenMs && createdMs - s.lastSeenMs <= 72 * 60 * 60 * 1000) s.recurrenceCount72h++;
    s.lastSeenMs = createdMs;

    if (resolveMinutes != null) s.resolveTimes.push(resolveMinutes);

    if (!s.topicCounts30d[topic]) s.topicCounts30d[topic] = { count: 0, examples: [] };
    s.topicCounts30d[topic].count++;

    const ex =
      safeTrim(r.requestOriginal) ||
      safeTrim(r.requestTranslated?.en) ||
      safeTrim(r.requestText) ||
      "";
    if (ex && s.topicCounts30d[topic].examples.length < 3) s.topicCounts30d[topic].examples.push(ex.slice(0, 140));
  }

  const problemRooms = [];
  const problemRoomsByRoom = {};

  for (const s of byRoom.values()) {
    let avg = null;
    let median = null;
    const times = s.resolveTimes.slice().sort((a, b) => a - b);
    if (times.length) {
      avg = times.reduce((a, b) => a + b, 0) / times.length;
      const mid = Math.floor(times.length / 2);
      median = times.length % 2 ? times[mid] : (times[mid - 1] + times[mid]) / 2;
    }

    const repeatCatsSum = Object.values(s.repeatCategories14d).reduce((a, b) => a + b, 0);

    const topTopics30d = Object.entries(s.topicCounts30d || {})
      .map(([topic, v]) => ({
        topic,
        count: v?.count || 0,
        examples: Array.isArray(v?.examples) ? v.examples : [],
      }))
      .sort((a, b) => (b.count || 0) - (a.count || 0))
      .slice(0, 5);

    const score = s.requestCount30d * 10 + s.recurrenceCount72h * 15 + (repeatCatsSum >= 3 ? 10 : 0);

    const entry = {
      roomNumber: s.roomNumber,
      windowDays,
      requestCount30d: s.requestCount30d,
      repeatCategories14d: s.repeatCategories14d,
      recurrenceCount72h: s.recurrenceCount72h,
      avgTimeToResolveMinutes: avg != null ? Number(avg.toFixed(1)) : null,
      medianTimeToResolveMinutes: median != null ? Number(median.toFixed(1)) : null,
      lastRequestAtMs: s.lastRequestMs,
      score,
      topTopics30d,
    };

    problemRooms.push(entry);
    problemRoomsByRoom[String(s.roomNumber)] = entry;
  }

  problemRooms.sort((a, b) => (b.score || 0) - (a.score || 0));

  const payload = {
    hotelCode,
    windowDays,
    generatedAtMs: nowMs,
    lastRequestAtMs,
    problemRooms,
    problemRoomsByRoom,
    problemRoomsSummary: {
      roomsAnalyzed: problemRooms.length,
      dataCoverage: {
        totalRequestsScanned,
        withRoomNumber,
        missingRoomNumber,
        missingCreatedAtMs,
      },
    },
  };

  await db.ref(`hotels/${hotelCode}/memory/problemRooms`).set(payload);
  return payload;
}

/* --------------------------- Insights Builder (WINDOWED) --------------------------- */

function normalizeCategoryUpper(v) {
  const s = safeTrim(v);
  return s ? s.toUpperCase() : "OTHER";
}

function buildCallCountsByCategory(requestRows) {
  const callsByCategory = {};
  for (const r of requestRows) {
    const cat = normalizeCategoryUpper(r?.category);
    callsByCategory[cat] = (callsByCategory[cat] || 0) + 1;
  }
  return callsByCategory;
}

async function buildProblemRoomInsightsForHotel(
  hotelCodeRaw,
  { topN = 10, window = null, writeMode = "write" } = {}
) {
  const hotelCode = normalizeHotelCode(hotelCodeRaw);
  const apiKey = OPENAI_API_KEY.value();
  const nowMs = Date.now();

  const effectiveWindow =
    window?.startMs && window?.endMs
      ? window
      : { key: "last30d", label: "Last 30 days", startMs: nowMs - 30 * 24 * 60 * 60 * 1000, endMs: nowMs };

  const rows = await readAllHotelRequests(hotelCode);

  const inWindow = [];
  for (const row of rows) {
    const r = row?.data || {};
    const status = safeTrim(r.status || "OPEN").toUpperCase();
    if (status !== "OPEN" && status !== "ACCEPTED") continue;

    const createdMs = toMsFromRecord(r);
    if (!createdMs) continue;

    if (createdMs >= effectiveWindow.startMs && createdMs < effectiveWindow.endMs) inWindow.push(r);
  }

  const totalCalls = inWindow.length;
  const callsByCategory = buildCallCountsByCategory(inWindow);

  const byRoom = new Map();
  let missingRoom = 0;

  for (const r of inWindow) {
    const room = getRoomNumberFromRecord(r);
    if (!room) {
      missingRoom++;
      continue;
    }

    const createdMs = toMsFromRecord(r);
    if (!createdMs) continue;

    const status = safeTrim(r.status || "OPEN").toUpperCase();
    const category = normalizeCategoryUpper(r.category);
    const topic = extractRequestTopic(r);

    const resolvedMs = resolveMsFromRecord(r);
    const isResolved = status === "ACCEPTED" && resolvedMs && resolvedMs >= createdMs;
    const resolveMinutes = isResolved ? (resolvedMs - createdMs) / 60000 : null;

    if (!byRoom.has(room)) {
      byRoom.set(room, {
        roomNumber: room,
        requestCount: 0,
        categories: {},
        recurrenceCount72h: 0,
        resolveTimes: [],
        lastSeenMs: 0,
        lastRequestMs: 0,
        topicCounts: {},
      });
    }

    const s = byRoom.get(room);
    s.requestCount++;
    s.lastRequestMs = Math.max(s.lastRequestMs, createdMs);

    s.categories[category] = (s.categories[category] || 0) + 1;

    if (s.lastSeenMs && createdMs - s.lastSeenMs <= 72 * 60 * 60 * 1000) s.recurrenceCount72h++;
    s.lastSeenMs = createdMs;

    if (resolveMinutes != null) s.resolveTimes.push(resolveMinutes);

    if (!s.topicCounts[topic]) s.topicCounts[topic] = { count: 0, examples: [] };
    s.topicCounts[topic].count++;

    const ex =
      safeTrim(r.requestOriginal) ||
      safeTrim(r.requestTranslated?.en) ||
      safeTrim(r.requestText) ||
      "";
    if (ex && s.topicCounts[topic].examples.length < 3) s.topicCounts[topic].examples.push(ex.slice(0, 140));
  }

  const roomStats = [];
  for (const s of byRoom.values()) {
    let median = null;
    const times = s.resolveTimes.slice().sort((a, b) => a - b);
    if (times.length) {
      const mid = Math.floor(times.length / 2);
      median = times.length % 2 ? times[mid] : (times[mid - 1] + times[mid]) / 2;
    }

    const topTopics = Object.entries(s.topicCounts || {})
      .map(([topic, v]) => ({
        topic,
        count: v?.count || 0,
        examples: Array.isArray(v?.examples) ? v.examples : [],
      }))
      .sort((a, b) => (b.count || 0) - (a.count || 0))
      .slice(0, 5);

    const catsSum = Object.values(s.categories || {}).reduce((a, b) => a + (Number(b) || 0), 0);
    const score = s.requestCount * 10 + s.recurrenceCount72h * 15 + (catsSum >= 3 ? 10 : 0);

    roomStats.push({
      roomNumber: s.roomNumber,
      score,
      requestCount: s.requestCount,
      categories: s.categories,
      recurrenceCount72h: s.recurrenceCount72h,
      medianTimeToResolveMinutes: median != null ? Number(median.toFixed(1)) : null,
      lastRequestAtMs: s.lastRequestMs,
      topTopics,
    });
  }

  roomStats.sort((a, b) => (b.score || 0) - (a.score || 0));
  const topRooms = roomStats.slice(0, topN);

  const roomLines = topRooms.map((r) => {
    const topics = Array.isArray(r.topTopics) ? r.topTopics.map((t) => `${t.topic}(${t.count})`).join(", ") : "";
    const cats = r.categories ? JSON.stringify(r.categories) : "{}";
    return `Room ${r.roomNumber}: score=${r.score}, requests=${r.requestCount}, categories=${cats}, recurrence72h=${r.recurrenceCount72h}, medianResolveMin=${r.medianTimeToResolveMinutes ?? "n/a"}, topTopics=${topics}`;
  });

  const prompt = [
    "You are an operations analyst for a hotel.",
    "Your job: produce manager-friendly insights and actionable recommendations.",
    "",
    "Return ONLY valid minified JSON. No markdown. No code fences. No extra text.",
    "Schema MUST be:",
    "{",
    ' "summary": string,',
    ' "topIssues": [{"issue":string,"evidence":string,"impact":string,"recommendation":string}],',
    ' "roomAlerts": [{"roomNumber":string,"alert":string,"evidence":string,"recommendedAction":[string]}],',
    ' "recommendations": [string],',
    ' "checklist": [string]',
    "}",
    "",
    "Rules:",
    "- Use evidence from the roomLines data.",
    "- Focus recommendations on operational fixes (par levels, pre-stocking, checklist, preventive maintenance).",
    "- Keep wording plain English for managers.",
    "",
    `Hotel: ${hotelCode}`,
    `Window: ${effectiveWindow.label} (${new Date(effectiveWindow.startMs).toISOString()} to ${new Date(
      effectiveWindow.endMs
    ).toISOString()})`,
    `Total Calls in Window: ${totalCalls}`,
    `Calls by Category in Window: ${JSON.stringify(callsByCategory)}`,
    "",
    "RoomLines:",
    roomLines.length ? roomLines.join("\n") : "(no room data available for this window)",
  ].join("\n");

  const gen = await generateInsightsJson({ apiKey, prompt, model: "gpt-5.2", effort: "medium" });

  let finalPayload;
  if (!gen.parseOk || !gen.json) {
    finalPayload = {
      hotelCode,
      window: effectiveWindow,
      generatedAtMs: Date.now(),
      model: "gpt-5.2",
      ok: false,
      parseOk: false,
      parseSample: gen.parseSample || "",
      summary: "",
      topIssues: [],
      roomAlerts: [],
      recommendations: [],
      checklist: [],
      totalCalls,
      callsByCategory,
      dataCoverage: {
        totalRequestsInWindow: inWindow.length,
        roomsInWindow: byRoom.size,
        missingRoomNumber: missingRoom,
      },
    };
  } else {
    const j = gen.json || {};
    finalPayload = {
      hotelCode,
      window: effectiveWindow,
      generatedAtMs: Date.now(),
      model: "gpt-5.2",
      ok: true,
      parseOk: true,
      summary: safeTrim(j.summary),
      topIssues: Array.isArray(j.topIssues) ? j.topIssues : [],
      roomAlerts: Array.isArray(j.roomAlerts) ? j.roomAlerts : [],
      recommendations: Array.isArray(j.recommendations) ? j.recommendations : [],
      checklist: Array.isArray(j.checklist) ? j.checklist : [],
      totalCalls,
      callsByCategory,
      dataCoverage: {
        totalRequestsInWindow: inWindow.length,
        roomsInWindow: byRoom.size,
        missingRoomNumber: missingRoom,
      },
    };
  }

  if (writeMode !== "skipWrite") {
    await db.ref(`hotels/${hotelCode}/insights/problemRoomInsights`).set(finalPayload);
    await db.ref(`hotels/${hotelCode}/insights/problemRooms`).set(finalPayload); // back-compat
  }

  return finalPayload;
}

/* --------------------------- HTTPS: createOpenRequest --------------------------- */

exports.createOpenRequest = onRequest(
  { region: "us-central1", secrets: [OPENAI_API_KEY] },
  async (req, res) => {
    setCors(res);
    if (req.method === "OPTIONS") return res.status(204).send("");

    try {
      if (req.method !== "POST") return res.status(405).send("POST only");

      const { hotelCode: hotelCodeRaw, roomNumber, guestName, category, lang, requestText } = req.body || {};
      if (!hotelCodeRaw) return res.status(400).json({ error: "hotelCode required" });

      const hotelCode = normalizeHotelCode(hotelCodeRaw);

      const tzSnap = await db.ref(`hotels/${hotelCode}/config/timeZone`).get();
      const hotelTimeZone = tzSnap.val() || "America/New_York";

      const now = new Date();
      const createdAt = formatLocalIso(now, hotelTimeZone);
      const createdAtMs = now.getTime();

      const requestId = db.ref().push().key;

      const apiKey = OPENAI_API_KEY.value();
      const t = await translateAll({ requestText, sourceLang: lang, apiKey });

      const payload = {
        status: "OPEN",
        category: safeTrim(category).toUpperCase() || "OTHER",

        createdAt,
        createdAtMs,
        timeZone: hotelTimeZone,

        roomNumber: roomNumber || "",
        guestName: guestName || "",

        originalLanguage: t.originalLanguage,
        requestOriginal: t.requestOriginal,
        requestTranslated: t.requestTranslated,
        translationMeta: t.translationMeta || { ok: false },

        acceptedAt: "",
        acceptedAtMs: "",
        acceptedBy: "",
        acceptedByDisplay: "",

        requestComments: "",
      };

      await db.ref(`hotels/${hotelCode}/requests/${requestId}`).set(payload);

      return res.json({ ok: true, requestId, translationOk: !!t.translationMeta?.ok });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: String(err?.message || err) });
    }
  }
);

/* --------------------------- HTTPS: acceptRequest --------------------------- */

exports.acceptRequest = onRequest({ region: "us-central1" }, async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).send("");

  try {
    if (req.method !== "POST") return res.status(405).send("POST only");

    const { hotelCode: hotelCodeRaw, requestId, acceptedByDisplay, acceptedBy } = req.body || {};
    if (!hotelCodeRaw || !requestId) return res.status(400).json({ error: "hotelCode and requestId required" });

    const hotelCode = normalizeHotelCode(hotelCodeRaw);

    const tzSnap = await db.ref(`hotels/${hotelCode}/config/timeZone`).get();
    const hotelTimeZone = tzSnap.val() || "America/New_York";

    const now = new Date();
    const acceptedAt = formatLocalIso(now, hotelTimeZone);
    const acceptedAtMs = now.getTime();

    await db.ref(`hotels/${hotelCode}/requests/${requestId}`).update({
      status: "ACCEPTED",
      acceptedAt,
      acceptedAtMs,
      acceptedBy: safeTrim(acceptedBy || ""),
      acceptedByDisplay: safeTrim(acceptedByDisplay).slice(0, 32),
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: String(err?.message || err) });
  }
});

/* --------------------------- HTTPS: setRequestComment --------------------------- */

exports.setRequestComment = onRequest({ region: "us-central1" }, async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).send("");

  try {
    if (req.method !== "POST") return res.status(405).send("POST only");

    const { hotelCode: hotelCodeRaw, requestId, requestComments } = req.body || {};
    if (!hotelCodeRaw || !requestId) return res.status(400).json({ error: "hotelCode and requestId required" });

    const hotelCode = normalizeHotelCode(hotelCodeRaw);

    await db.ref(`hotels/${hotelCode}/requests/${requestId}`).update({
      requestComments: safeTrim(requestComments).slice(0, 500),
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: String(err?.message || err) });
  }
});

/* --------------------------- HTTPS: archiveRequest --------------------------- */

exports.archiveRequest = onRequest({ region: "us-central1" }, async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).send("");

  try {
    if (req.method !== "POST") return res.status(405).send("POST only");

    const { hotelCode: hotelCodeRaw, requestId, archivedByDisplay, archivedBy } = req.body || {};
    if (!hotelCodeRaw || !requestId) return res.status(400).json({ error: "hotelCode and requestId required" });

    const hotelCode = normalizeHotelCode(hotelCodeRaw);

    const reqRef = db.ref(`hotels/${hotelCode}/requests/${requestId}`);
    const snap = await reqRef.get();
    const data = snap.val();

    if (!data) return res.status(404).json({ error: "request not found" });

    const now = Date.now();
    const archivedAt = new Date(now).toISOString();

    const archivePayload = {
      ...(data || {}),
      archivedAt,
      archivedAtMs: now,
      archivedBy: safeTrim(archivedBy || ""),
      archivedByDisplay: safeTrim(archivedByDisplay || "").slice(0, 32),
    };

    const updates = {};
    updates[`hotels/${hotelCode}/archivedRequests/${requestId}`] = archivePayload;
    updates[`hotels/${hotelCode}/requests/${requestId}`] = null;

    await db.ref().update(updates);

    return res.json({ ok: true, requestId });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: String(err?.message || err) });
  }
});

/* --------------------------- HTTPS: setUserHotelMap (ADMIN) --------------------------- */

exports.setUserHotelMap = onRequest({ region: "us-central1" }, async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).send("");

  try {
    if (req.method !== "POST") return res.status(405).send("POST only");

    const { uid, hotelCode, role, active, email } = req.body || {};
    if (!uid) return res.status(400).json({ error: "uid required" });
    if (!hotelCode) return res.status(400).json({ error: "hotelCode required" });

    const payload = {
      active: active !== false,
      hotelCode: String(hotelCode),
      role: role ? String(role) : "manager",
      ...(email ? { email: String(email) } : {}),
    };

    await db.ref(`userHotelMap/${uid}`).set(payload);
    return res.json({ ok: true, path: `userHotelMap/${uid}`, payload });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: String(err?.message || err) });
  }
});

/* --------------------------- HTTPS: setupFrontDeskHotel (ADMIN) --------------------------- */

exports.setupFrontDeskHotel = onRequest({ region: "us-central1" }, async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).send("");

  try {
    if (req.method !== "POST") return res.status(405).send("POST only");

    const {
      email,
      password,
      hotelCode: hotelCodeRaw,
      hotelDisplayName,
      googlePlaceId,
      serpSearchQuery,
      timeZone,
      role,
      active,
    } = req.body || {};

    const hotelCode = normalizeHotelCode(hotelCodeRaw);
    const normalizedEmail = safeTrim(email).toLowerCase();

    if (!hotelCode) {
      return res.status(400).json({ ok: false, error: "hotelCode required" });
    }

    if (!normalizedEmail) {
      return res.status(400).json({ ok: false, error: "email required" });
    }

    if (!safeTrim(hotelDisplayName)) {
      return res.status(400).json({ ok: false, error: "hotelDisplayName required" });
    }

    if (!safeTrim(timeZone)) {
      return res.status(400).json({ ok: false, error: "timeZone required" });
    }

    if (!safeTrim(googlePlaceId)) {
      return res.status(400).json({ ok: false, error: "googlePlaceId required" });
    }

    const nowMs = Date.now();

    let userRecord;

    try {
      userRecord = await auth.getUserByEmail(normalizedEmail);
    } catch (err) {
      if (err?.code === "auth/user-not-found") {
        if (!safeTrim(password)) {
          return res.status(400).json({
            ok: false,
            error: "User does not exist yet. Provide password to create the auth user.",
          });
        }

        userRecord = await auth.createUser({
          email: normalizedEmail,
          password: safeTrim(password),
          emailVerified: true,
          disabled: false,
        });
      } else {
        throw err;
      }
    }

    const uid = userRecord.uid;

    const updates = {};

    // 1) userHotelMap
    updates[`userHotelMap/${uid}`] = {
      active: active !== false,
      email: normalizedEmail,
      hotelCode,
      role: safeTrim(role) || "manager",
      updatedAtMs: nowMs,
    };

    // 2) hotel config
    updates[`hotels/${hotelCode}/config`] = {
      hotelCode,
      hotelDisplayName: safeTrim(hotelDisplayName),
      timeZone: safeTrim(timeZone),
      updatedAtMs: nowMs,
      reputation: {
        active: true,
        googlePlaceId: safeTrim(googlePlaceId),
        serpDataId: safeTrim(req.body?.serpDataId || ""),
        serpDataCid: safeTrim(req.body?.serpDataCid || ""),
        serpSearchQuery: safeTrim(serpSearchQuery || hotelDisplayName),
        hotelDisplayName: safeTrim(hotelDisplayName),
        timeZone: safeTrim(timeZone),
        updatedAtMs: nowMs,
        serpResolvedAtMs: "",
        serpResolvedTitle: "",
      },
    };

    // 3) initialize required branches if missing
    const existingRequestsSnap = await db.ref(`hotels/${hotelCode}/requests`).get();
    if (!existingRequestsSnap.exists()) {
      updates[`hotels/${hotelCode}/requests`] = {};
    }

    const existingArchivedSnap = await db.ref(`hotels/${hotelCode}/archivedRequests`).get();
    if (!existingArchivedSnap.exists()) {
      updates[`hotels/${hotelCode}/archivedRequests`] = {};
    }

    const existingInsightsSnap = await db.ref(`hotels/${hotelCode}/insights`).get();
    if (!existingInsightsSnap.exists()) {
      updates[`hotels/${hotelCode}/insights`] = {
        initializedAtMs: nowMs,
        note: "Initialized by setupFrontDeskHotel",
      };
    }

    const existingMemorySnap = await db.ref(`hotels/${hotelCode}/memory`).get();
    if (!existingMemorySnap.exists()) {
      updates[`hotels/${hotelCode}/memory`] = {
        initializedAtMs: nowMs,
        note: "Initialized by setupFrontDeskHotel",
      };
    }

    const existingReputationSnap = await db.ref(`hotels/${hotelCode}/reputation`).get();
    if (!existingReputationSnap.exists()) {
      updates[`hotels/${hotelCode}/reputation`] = {
        serpapi: {
          meta: {
            hotelCode,
            placeId: safeTrim(googlePlaceId),
            fetchedAtMs: nowMs,
            note: "Initialized by setupFrontDeskHotel",
          },
          reviews: {},
        },
        summary: {
          placeId: safeTrim(googlePlaceId),
          placeName: safeTrim(hotelDisplayName),
          source: "google",
          rating: null,
          userRatingsTotal: null,
          fetchedAtMs: nowMs,
        },
      };
    }

    await db.ref().update(updates);

    return res.json({
      ok: true,
      hotelCode,
      uid,
      email: normalizedEmail,
      createdAuthUser: !!safeTrim(password),
      pathsWritten: Object.keys(updates),
    });
  } catch (err) {
    console.error("setupFrontDeskHotel error:", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

/* --------------------------- HTTPS: rebuildProblemRooms --------------------------- */

exports.rebuildProblemRooms = onRequest({ region: "us-central1" }, async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).send("");

  try {
    const hotelCodeRaw = safeTrim(req.query?.hotelCode || "");
    if (!hotelCodeRaw) return res.status(400).json({ error: "hotelCode query param required" });

    const hotelCode = normalizeHotelCode(hotelCodeRaw);

    const windowDays = Number(req.query?.windowDays || 30);
    const safeWindow = Number.isFinite(windowDays) ? Math.min(Math.max(windowDays, 1), 90) : 30;

    const payload = await buildProblemRoomsForHotel(hotelCode, { windowDays: safeWindow });

    return res.json({
      ok: true,
      hotelCode,
      windowDays: safeWindow,
      roomsAnalyzed: payload?.problemRoomsSummary?.roomsAnalyzed || 0,
      dataCoverage: payload?.problemRoomsSummary?.dataCoverage || {},
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

/* --------------------------- Scheduled: buildProblemRoomsAllHotels --------------------------- */

exports.buildProblemRoomsAllHotels = onSchedule(
  { region: "us-central1", schedule: "10 3 * * *", timeZone: "America/New_York" },
  async () => {
    const hotelsSnap = await db.ref("hotels").get();
    const hotels = hotelsSnap.val() || {};
    const codes = Object.keys(hotels);

    for (const hotelCodeRaw of codes) {
      const hotelCode = normalizeHotelCode(hotelCodeRaw);
      try {
        await buildProblemRoomsForHotel(hotelCode, { windowDays: 30 });
      } catch (e) {
        console.error("buildProblemRoomsAllHotels error:", hotelCode, String(e?.message || e));
      }
    }
  }
);

/* --------------------------- Window Helpers (Prev Day in TZ) --------------------------- */

function zonedMidnightToUtcMs({ year, month, day }, timeZone) {
  const utcGuess = Date.UTC(year, month - 1, day, 0, 0, 0);
  const zonedStr = new Date(utcGuess).toLocaleString("en-US", { timeZone });
  const zoned = new Date(zonedStr);
  const offsetMs = zoned.getTime() - utcGuess;
  return utcGuess - offsetMs;
}

function getPrevDayWindowMs(timeZone, nowMs) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(nowMs));

  const getPart = (type) => parts.find((p) => p.type === type)?.value;
  const yyyy = Number(getPart("year"));
  const mm = Number(getPart("month"));
  const dd = Number(getPart("day"));

  const todayStartUtcMs = zonedMidnightToUtcMs({ year: yyyy, month: mm, day: dd }, timeZone);
  const yesterdayStartUtcMs = todayStartUtcMs - 24 * 60 * 60 * 1000;

  return { key: "prevDay", label: "Day before", startMs: yesterdayStartUtcMs, endMs: todayStartUtcMs };
}

/* --------------------------- HTTPS: rebuildProblemRoomInsights --------------------------- */

exports.rebuildProblemRoomInsights = onRequest(
  { region: "us-central1", secrets: [OPENAI_API_KEY], timeoutSeconds: 300, memory: "1GiB" },
  async (req, res) => {
    setCors(res);
    if (req.method === "OPTIONS") return res.status(204).send("");

    try {
      const hotelCodeRaw = safeTrim(req.query?.hotelCode || "");
      if (!hotelCodeRaw) return res.status(400).json({ ok: false, error: "hotelCode query param required" });

      const hotelCode = normalizeHotelCode(hotelCodeRaw);

      const topN = Number(req.query?.topN || 10);
      const safeTopN = Number.isFinite(topN) ? Math.min(Math.max(topN, 1), 25) : 10;

      const rangeRaw = safeTrim(req.query?.range || "last24h").toLowerCase();
      const range = ["last24h", "prevday", "last30d"].includes(rangeRaw) ? rangeRaw : "last24h";

      const nowMs = Date.now();
      const tzSnap = await db.ref(`hotels/${hotelCode}/config/timeZone`).get();
      const hotelTimeZone = tzSnap.val() || "America/New_York";

      const windowDef =
        range === "last30d"
          ? { key: "last30d", label: "Last 30 days", startMs: nowMs - 30 * 24 * 60 * 60 * 1000, endMs: nowMs }
          : range === "prevday"
          ? getPrevDayWindowMs(hotelTimeZone, nowMs)
          : { key: "last24h", label: "Last 24 hours", startMs: nowMs - 24 * 60 * 60 * 1000, endMs: nowMs };

      const windowResult = await buildProblemRoomInsightsForHotel(hotelCode, { topN: safeTopN, window: windowDef });

      const trendWindow = {
        key: "trend30d",
        label: "Trend (30 days)",
        startMs: nowMs - 30 * 24 * 60 * 60 * 1000,
        endMs: nowMs,
      };

      const trendResult = await buildProblemRoomInsightsForHotel(hotelCode, {
        topN: safeTopN,
        window: trendWindow,
        writeMode: "skipWrite",
      });

      await db.ref(`hotels/${hotelCode}/insights/problemRoomInsightsTrend30d`).set(trendResult);

      return res.json({
        ok: true,
        hotelCode,
        range: windowDef.key,
        rangeLabel: windowDef.label,
        generatedAtMs: Date.now(),
        written: {
          windowPath: `hotels/${hotelCode}/insights/problemRoomInsights`,
          trend30dPath: `hotels/${hotelCode}/insights/problemRoomInsightsTrend30d`,
        },
        counts: {
          windowTopN: Array.isArray(windowResult?.items) ? windowResult.items.length : null,
          trendTopN: Array.isArray(trendResult?.items) ? trendResult.items.length : null,
        },
      });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  }
);

/* --------------------------- rebuildCategoryInsights --------------------------- */

exports.rebuildCategoryInsights = onRequest(
  { region: "us-central1", secrets: [OPENAI_API_KEY], timeoutSeconds: 300, memory: "1GiB" },
  async (req, res) => {
    setCors(res);
    if (req.method === "OPTIONS") return res.status(204).send("");
    if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Use POST" });

    try {
      function normalizeTextLocal(s) {
        return safeTrim(s).toLowerCase().replace(/\s+/g, " ").replace(/[^\w\s]/g, "").trim();
      }

      function pickAnyTranslatedText(d) {
        const rt = d?.requestTranslated;
        if (rt && typeof rt === "object") {
          if (typeof rt.en === "string" && rt.en.trim()) return rt.en.trim();
          for (const v of Object.values(rt)) if (typeof v === "string" && v.trim()) return v.trim();
        }
        return safeTrim(d?.requestOriginal) || safeTrim(d?.requestText) || "";
      }

      function computeTopPhrases(texts, topN = 12) {
        const counts = new Map();
        const stop = new Set(["the","a","an","and","or","to","for","of","in","on","at","is","are","was","were","be","been","with","please","can","could","i","we","you","my","our","your"]);
        for (const raw of texts) {
          const s = normalizeTextLocal(raw);
          if (!s) continue;
          const words = s.split(" ").filter((w) => w && !stop.has(w) && w.length >= 3);
          for (let n = 2; n <= 4; n++) {
            for (let i = 0; i + n <= words.length; i++) {
              const phrase = words.slice(i, i + n).join(" ");
              counts.set(phrase, (counts.get(phrase) || 0) + 1);
            }
          }
        }
        return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN).map(([phrase, count]) => ({ phrase, count }));
      }

      function sampleEven(arr, max = 70) {
        if (arr.length <= max) return arr;
        const out = [];
        const step = arr.length / max;
        for (let i = 0; i < max; i++) out.push(arr[Math.floor(i * step)]);
        return out;
      }

      function computeWindow(rangeKey, hotelTimeZone) {
        const nowMs = Date.now();
        if (rangeKey === "last24h") return { key: "last24h", label: "Last 24 hours", startMs: nowMs - 24 * 60 * 60 * 1000, endMs: nowMs };
        if (rangeKey === "prevday") return getPrevDayWindowMs(hotelTimeZone || "America/New_York", nowMs);
        return { key: "last30d", label: "Last 30 days", startMs: nowMs - 30 * 24 * 60 * 60 * 1000, endMs: nowMs };
      }

      const hotelCodeRaw = safeTrim(req.query?.hotelCode || "");
      const categoryRaw = safeTrim(req.query?.category || "");
      const rangeRaw = safeTrim(req.query?.range || "").toLowerCase();
      const topNRaw = safeTrim(req.query?.topN || "10");

      if (!hotelCodeRaw) return res.status(400).json({ ok: false, error: "Missing hotelCode" });
      if (!categoryRaw) return res.status(400).json({ ok: false, error: "Missing category" });
      if (!rangeRaw) return res.status(400).json({ ok: false, error: "Missing range (last24h|prevday|last30d)" });
      if (!["last24h", "prevday", "last30d"].includes(rangeRaw)) return res.status(400).json({ ok: false, error: "Invalid range (last24h|prevday|last30d)" });

      const hotelCode = normalizeHotelCode(hotelCodeRaw);
      const category = categoryRaw.trim();
      const wantCat = category.toLowerCase();
      const categorySlug = slugify(category, { lower: true, strict: true, trim: true }) || "general";

      const topN = Number(topNRaw || "10");
      const topNFinal = Number.isFinite(topN) && topN > 0 ? Math.min(topN, 50) : 10;

      const tzSnap = await db.ref(`hotels/${hotelCode}/config/timeZone`).get();
      const hotelTimeZone = tzSnap.val() || "America/New_York";
      const window = computeWindow(rangeRaw, hotelTimeZone);

      const [openSnap, archivedSnap] = await Promise.all([
        db.ref(`hotels/${hotelCode}/requests`).get(),
        db.ref(`hotels/${hotelCode}/archivedRequests`).get(),
      ]);

      const openRaw = openSnap.val() || {};
      const archivedRaw = archivedSnap.val() || {};

      const filtered = [];

      const pushIfMatch = (id, data) => {
        const cat = typeof data?.category === "string" ? data.category.trim().toLowerCase() : "";
        if (cat !== wantCat) return;

        const createdMs =
          toMs(data?.createdAtMs) ??
          toMs(data?.createdAt) ??
          toMs(data?.acceptedAtMs) ??
          toMs(data?.acceptedAt) ??
          toMs(data?.archivedAtMs) ??
          toMs(data?.archivedAt) ??
          null;

        if (!createdMs) return;
        if (createdMs < window.startMs || createdMs > window.endMs) return;

        filtered.push({ id, data, createdMs });
      };

      for (const [id, data] of Object.entries(openRaw)) pushIfMatch(id, data || {});
      for (const [id, data] of Object.entries(archivedRaw)) pushIfMatch(id, data || {});

      const totalCalls = filtered.length;

      const roomCounts = {};
      const texts = [];

      for (const it of filtered) {
        const d = it.data || {};
        const room =
          (safeTrim(d.roomNumber) ||
            safeTrim(d.room) ||
            safeTrim(d.roomNo) ||
            safeTrim(d.room_number) ||
            "—").trim() || "—";

        roomCounts[room] = (roomCounts[room] || 0) + 1;

        const t = pickAnyTranslatedText(d);
        if (t) texts.push(t);
      }

      const topRooms = Object.entries(roomCounts)
        .filter(([r]) => r !== "—")
        .sort((a, b) => (b[1] || 0) - (a[1] || 0))
        .slice(0, topNFinal)
        .map(([room, count]) => ({ room, count }));

      const sampledTexts = sampleEven(texts, 70);
      const topPhrases = computeTopPhrases(sampledTexts, 15);

      let humanActions = [];
      let softwareAutomations = [];
      let managementDecisions = [];
      let rootCauses = [];
      let confidenceScore = 0;

      let recommendations = [];
      let checklist = [];
      let quickWins = [];
      let longerTermFixes = [];

      if (totalCalls === 0) {
        humanActions = [`No ${category} requests found in this window.`];
        checklist = ["No action needed."];
      } else {
        const apiKey = OPENAI_API_KEY.value();

        const prompt = [
          "You are an operations analyst for a hotel front desk and hotel management team.",
          "Use ONLY the provided data. Do NOT invent facts.",
          "Return ONLY strict minified JSON. No markdown, no extra text.",
          "",
          "Return JSON with EXACTLY these keys:",
          "humanActions (string[]), softwareAutomations (string[]), managementDecisions (string[]), rootCauses (string[]), confidenceScore (number)",
          "",
          "Definitions / rules:",
          "- humanActions: tasks that require a person to physically do something (front desk, security, housekeeping, maintenance).",
          "- softwareAutomations: tasks that could be handled programmatically by software workflows (alerts, rules, dashboards, auto-tagging, follow-ups, escalation routing, auto-ticket creation).",
          "- managementDecisions: policy, staffing, procurement, training programs, or building changes that require management approval.",
          "- rootCauses: ONLY include causes that are clearly supported by the evidence.",
          "- confidenceScore: 0–100.",
          "",
          "Output quality requirements:",
          "- Provide 6–12 items in humanActions when possible.",
          "- Provide 6–12 items in softwareAutomations when possible.",
          "- Provide 3–8 items in managementDecisions when possible.",
          "- Provide 3–8 items in rootCauses when possible.",
          "- Keep each bullet specific and testable.",
          "",
          `Hotel: ${hotelCode}`,
          `Category: ${category}`,
          `Window: ${window.label} (${new Date(window.startMs).toISOString()} to ${new Date(window.endMs).toISOString()})`,
          `Total requests in window: ${totalCalls}`,
          `Top rooms: ${JSON.stringify(topRooms.slice(0, 10))}`,
          `Top phrases: ${JSON.stringify(topPhrases.slice(0, 15))}`,
          `Sample requests: ${JSON.stringify(sampledTexts.slice(0, 35))}`,
        ].join("\n");

        const gen = await generateInsightsJson({ apiKey, prompt, model: "gpt-5.2", effort: "medium" });

        if (gen.parseOk && gen.json) {
          const j = gen.json || {};

          humanActions = Array.isArray(j.humanActions) ? j.humanActions.filter(Boolean).slice(0, 20) : [];
          softwareAutomations = Array.isArray(j.softwareAutomations) ? j.softwareAutomations.filter(Boolean).slice(0, 20) : [];
          managementDecisions = Array.isArray(j.managementDecisions) ? j.managementDecisions.filter(Boolean).slice(0, 20) : [];
          rootCauses = Array.isArray(j.rootCauses) ? j.rootCauses.filter(Boolean).slice(0, 12) : [];

          const cs = Number(j.confidenceScore);
          confidenceScore = Number.isFinite(cs) ? Math.max(0, Math.min(100, Math.round(cs))) : 0;

          recommendations = [...humanActions.slice(0, 6), ...softwareAutomations.slice(0, 6)].filter(Boolean);
          checklist = humanActions.slice(0, 12).filter(Boolean);
          quickWins = [...humanActions.slice(0, 5), ...softwareAutomations.slice(0, 5)].filter(Boolean);
          longerTermFixes = managementDecisions.slice(0, 8).filter(Boolean);
        } else {
          humanActions = [
            `${category}: ${totalCalls} request(s) in this window.`,
            topRooms.length ? `Top rooms: ${topRooms.slice(0, 5).map((x) => `${x.room} (${x.count})`).join(", ")}` : "",
            "AI generation failed (parse error). Showing non-AI summary only.",
          ].filter(Boolean);

          softwareAutomations = [
            "Add an alert for repeat rooms in this category (e.g., 3+ requests in 7 days).",
            "Auto-tag and group requests by category + room for manager review.",
          ];

          managementDecisions = ["Review staffing/SOP coverage for this category during peak periods."];
          confidenceScore = 10;

          recommendations = [...humanActions];
          checklist = ["Review sample requests for repeat themes.", "Confirm stock levels / SOP coverage.", "Add resolution notes for repeat rooms."];
          quickWins = ["Review top rooms", "Add repeat-room alert", "Tighten SOP checklist"];
          longerTermFixes = ["Policy/staffing review for this category"];
        }
      }

      const payload = {
        ok: true,
        hotelCode,
        range: rangeRaw,
        category,
        categorySlug,
        generatedAtMs: Date.now(),
        window,
        totalCalls,
        topRooms,
        topPhrases,
        sampleSize: sampledTexts.length,

        humanActions,
        softwareAutomations,
        managementDecisions,
        rootCauses,
        confidenceScore,

        recommendations,
        checklist,
        quickWins,
        longerTermFixes,
      };

      const path = `hotels/${hotelCode}/insights/categoryInsights/${rangeRaw}/${categorySlug}`;
      await db.ref(path).set(payload);

      return res.json({ ok: true, hotelCode, category, categorySlug, range: rangeRaw, path, totalCalls });
    } catch (e) {
      console.error("rebuildCategoryInsights error:", e);
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  }
);

/* --------------------------- Reputation Config --------------------------- */

exports.setHotelReputationConfig = onRequest({ region: "us-central1" }, async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).send("");

  try {
    const hotelCode = safeTrim(req.body?.hotelCode || req.query?.hotelCode);
    const googlePlaceId = safeTrim(req.body?.googlePlaceId || req.query?.googlePlaceId);
    const hotelDisplayName = safeTrim(req.body?.hotelDisplayName || req.query?.hotelDisplayName);

    if (!hotelCode || !googlePlaceId) {
      return res.status(400).json({ ok: false, error: "Missing hotelCode or googlePlaceId" });
    }

    const path = `hotels/${normalizeHotelCode(hotelCode)}/config/reputation`;

    await db.ref(path).set({
      googlePlaceId,
      hotelDisplayName: hotelDisplayName || "",
      active: true,
      updatedAtMs: Date.now(),
    });

    return res.json({ ok: true, path });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

/* --------------------------- Google Places Reviews (optional) --------------------------- */

exports.syncGoogleReviewsForHotel = onRequest(
  { region: "us-central1", timeoutSeconds: 120, memory: "512MiB", secrets: [GOOGLE_PLACES_API_KEY] },
  async (req, res) => {
    setCors(res);
    if (req.method === "OPTIONS") return res.status(204).send("");

    try {
      const hotelCode =
        (typeof req.query.hotelCode === "string" && req.query.hotelCode.trim()) ||
        (typeof req.body?.hotelCode === "string" && req.body.hotelCode.trim());

      if (!hotelCode) return res.status(400).json({ ok: false, error: "Missing hotelCode" });

      const hc = normalizeHotelCode(hotelCode);

      const configSnap = await db.ref(`hotels/${hc}/config/reputation`).get();
      const config = configSnap.val();

      if (!config?.googlePlaceId || !config?.active) {
        return res.status(400).json({ ok: false, error: "Reputation config missing or inactive" });
      }

      const placeId = String(config.googlePlaceId || "").trim();
      const apiKey = GOOGLE_PLACES_API_KEY.value();

      const url = `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`;

      const resp = await fetch(url, {
        method: "GET",
        headers: {
          "X-Goog-Api-Key": apiKey,
          "X-Goog-FieldMask": "displayName,rating,userRatingCount,reviews",
        },
      });

      const data = await resp.json().catch(() => ({}));

      if (!resp.ok) {
        return res.json({
          ok: false,
          reviewCount: 0,
          message: "Places API (New) request failed",
          httpStatus: resp.status,
          googleError: data?.error?.message || JSON.stringify(data).slice(0, 300),
          placeId,
        });
      }

      const placeName = data?.displayName?.text || "";
      const rating = data?.rating ?? null;
      const userRatingsTotal = data?.userRatingCount ?? null;

      const reviews = Array.isArray(data?.reviews) ? data.reviews : null;

      const nowMs = Date.now();

      if (!Array.isArray(reviews)) {
        await db.ref(`hotels/${hc}/reputation/summary`).set({
          source: "google",
          placeId,
          placeName,
          rating,
          userRatingsTotal,
          fetchedAtMs: nowMs,
        });

        return res.json({
          ok: true,
          reviewCount: 0,
          message: "Google returned no reviews array (Places API New)",
          placeName,
          rating,
          userRatingsTotal,
        });
      }

      const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;

      const updates = {};
      let count = 0;

      for (const r of reviews) {
        const reviewMs = Date.parse(String(r.publishTime || "")) || 0;
        if (!reviewMs) continue;
        if (nowMs - reviewMs > thirtyDaysMs) continue;

        const authorName = r?.authorAttribution?.displayName || "anon";
        const reviewId = `google_${authorName}_${reviewMs}`.replace(/[.#$[\]]/g, "").slice(0, 200);

        updates[`hotels/${hc}/reputation/reviews/${reviewId}`] = {
          reviewId,
          source: "google",
          rating: r.rating ?? null,
          dateMs: reviewMs,
          authorName,
          text: r?.originalText?.text || "",
          language: r?.originalText?.languageCode || "unknown",
          fetchedAtMs: nowMs,
        };

        count++;
      }

      updates[`hotels/${hc}/reputation/summary`] = {
        source: "google",
        placeId,
        placeName,
        rating,
        userRatingsTotal,
        fetchedAtMs: nowMs,
      };

      await db.ref(`hotels/${hc}/reputation/reviews`).set(null);
      if (Object.keys(updates).length > 0) await db.ref().update(updates);

      return res.json({ ok: true, reviewCount: count, placeName, rating, userRatingsTotal });
    } catch (e) {
      console.error("syncGoogleReviewsForHotel error:", e);
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  }
);

/* --------------------------- SerpAPI Reviews (shared helper) --------------------------- */

function sanitizeDbKey(s) {
  return String(s || "").replace(/[.#$[\]]/g, "").slice(0, 250);
}

function toMsFromIso(iso) {
  if (!iso) return null;
  const t = Date.parse(String(iso));
  return Number.isNaN(t) ? null : t;
}

async function fetchSerpApiReviews({
  apiKey,
  placeId = "",
  dataId = "",
  hl = "en",
  maxPages = 25,
  sortBy = "newestFirst",
  }) {
  let page = 0;
  let nextPageToken = null;

  const out = [];

  while (page < maxPages) {
    page++;

const params = new URLSearchParams();
params.set("engine", "google_maps_reviews");

if (dataId) {
  params.set("data_id", dataId);
} else if (placeId) {
  params.set("place_id", placeId);
} else {
  throw new Error("fetchSerpApiReviews requires dataId or placeId");
}

params.set("hl", hl);
params.set("sort_by", sortBy);
params.set("api_key", apiKey);

if (nextPageToken) params.set("next_page_token", nextPageToken);

    const url = `https://serpapi.com/search.json?${params.toString()}`;

    const resp = await fetch(url);
    const data = await resp.json().catch(() => ({}));

    const meta = data?.search_metadata || {};
    const status = safeTrim(meta?.status || "");
    if (status && status !== "Success") {
      throw new Error(
        `serpapi_not_success: ${safeTrim(status)} ${safeTrim(data?.error || data?.search_metadata?.error || "")}`.slice(
          0,
          280
        )
      );
    }

    const reviews = Array.isArray(data?.reviews) ? data.reviews : [];
    if (reviews.length === 0) break;

    out.push(...reviews);

    const token = safeTrim(data?.serpapi_pagination?.next_page_token || "");
    nextPageToken = token || null;
    if (!nextPageToken) break;
  }

  return { reviews: out, pagesFetched: page };
}


/* --------------------------- SerpAPI Fetch Open Table Reviews) --------------------------- */

async function fetchSerpApiOpenTableReviews({
  rid,
  openTableDomain = "www.opentable.com",
  apiKey,
  page = 1,
}) {
  try {
    if (!rid || !apiKey) {
      return { ok: false, reviews: [], error: "Missing rid or apiKey" };
    }

    const params = {
      engine: "open_table_reviews",
      rid,
      open_table_domain: openTableDomain,
      api_key: apiKey,
      page,
    };

    const { data } = await axios.get("https://serpapi.com/search.json", {
      params,
      timeout: 60000,
    });

    const reviews = Array.isArray(data?.reviews) ? data.reviews : [];

    return {
      ok: true,
      reviews,
      meta: {
        page: data?.search_information?.page ?? page,
        totalPages: data?.search_information?.total_pages ?? null,
        summary: data?.reviews_summary ?? null,
      },
      raw: data,
    };
  } catch (err) {
    console.error("fetchSerpApiOpenTableReviews error:", err?.response?.data || err?.message || err);
    return {
      ok: false,
      reviews: [],
      error: err?.response?.data || err?.message || "OpenTable fetch failed",
    };
  }
}

/* --------------------------- SerpAPI Place Signals--------------------------- */

async function fetchSerpApiPlaceSignals({
  apiKey,
  placeId = "",
  dataId = "",
  hl = "en",
}) {
  const params = new URLSearchParams();
  params.set("engine", "google_maps");

  if (placeId) {
    params.set("place_id", placeId);
  } else if (dataId) {
    params.set("data_id", dataId);
  } else {
    throw new Error("fetchSerpApiPlaceSignals requires placeId or dataId");
  }

  params.set("hl", hl);
  params.set("api_key", apiKey);

  const url = `https://serpapi.com/search.json?${params.toString()}`;
  const resp = await fetch(url);
  const data = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    throw new Error(`serp_place_signals_failed_${resp.status}`);
  }

  const placeResults = data?.place_results || {};

  const placeReviews = Array.isArray(placeResults?.reviews)
    ? placeResults.reviews
    : [];

  const userReviews = Array.isArray(placeResults?.user_reviews)
    ? placeResults.user_reviews
    : [];

  const ratingCount =
    placeResults?.user_ratings_total ??
    placeResults?.rating_count ??
    (typeof placeResults?.reviews === "number" ? placeResults.reviews : null) ??
    null;

  return {
    placeName: safeTrim(placeResults?.title || ""),
    rating: typeof placeResults?.rating === "number" ? placeResults.rating : null,
    userRatingsTotal: ratingCount,
    dataId: safeTrim(placeResults?.data_id || dataId || ""),
    dataCid: safeTrim(placeResults?.data_cid || ""),
    reviews: placeReviews,
    userReviews,
    raw: placeResults,
  };
}



async function resolveSerpPlaceIdsFromGooglePlaceId({
  googlePlaceId,
  apiKey,
  hotelDisplayName = "",
  serpSearchQuery = "",
}) {

  // 1️⃣ Try direct place lookup first
  const placeParams = new URLSearchParams();
  placeParams.set("engine", "google_maps");
  placeParams.set("place_id", googlePlaceId);
  placeParams.set("api_key", apiKey);

  const placeUrl = `https://serpapi.com/search.json?${placeParams.toString()}`;
  const placeResp = await fetch(placeUrl);
  const placeData = await placeResp.json().catch(() => ({}));

  if (placeResp.ok) {
    const placeResults = placeData?.place_results || {};

    const serpDataId = safeTrim(placeResults?.data_id || "");
    const serpDataCid = safeTrim(placeResults?.data_cid || "");
    const serpResolvedTitle = safeTrim(placeResults?.title || "");

    if (serpDataId) {
      return {
        serpDataId,
        serpDataCid,
        serpResolvedTitle,
        resolveMethod: "place_lookup",
      };
    }
  }

  // 2️⃣ Fallback: Google Maps search by name / query
  const q = safeTrim(serpSearchQuery) || safeTrim(hotelDisplayName);

  if (!q) {
    return {
      serpDataId: "",
      serpDataCid: "",
      serpResolvedTitle: "",
      resolveMethod: "none",
    };
  }

  const localParams = new URLSearchParams();
  localParams.set("engine", "google_maps");
  localParams.set("type", "search");
  localParams.set("q", q);
  localParams.set("hl", "en");
  localParams.set("api_key", apiKey);

  const localUrl = `https://serpapi.com/search.json?${localParams.toString()}`;
  const localResp = await fetch(localUrl);
  const localData = await localResp.json().catch(() => ({}));

  if (!localResp.ok) {
    throw new Error(`serp_local_lookup_failed_${localResp.status}`);
  }

  const localResults = Array.isArray(localData?.local_results)
    ? localData.local_results
    : [];

  const placeResults = localData?.place_results || {};

  const first = localResults[0] || placeResults || {};

  return {
    serpDataId: safeTrim(first?.data_id || ""),
    serpDataCid: safeTrim(first?.data_cid || ""),
    serpResolvedTitle: safeTrim(first?.title || ""),
    resolveMethod: "local_search",
    debugLocalCount: localResults.length,
    debugFirstTitle: safeTrim(first?.title || ""),
    debugFirstAddress: safeTrim(first?.address || ""),
    debugTopLevelKeys: Object.keys(localData || {}),
  };
}



/* --------------------------- HTTPS: resolveSerpDataIdForRestaurant --------------------------- */

exports.resolveSerpDataIdForRestaurant = onRequest(
  { region: "us-central1", timeoutSeconds: 120, memory: "512MiB", secrets: [SERPAPI_API_KEY] },
  async (req, res) => {
    setCors(res);
    if (req.method === "OPTIONS") return res.status(204).send("");
    if (req.method !== "GET") return res.status(405).json({ ok: false, error: "Use GET" });

    try {
      const restaurantCodeRaw =
        (typeof req.query.restaurantCode === "string" && req.query.restaurantCode.trim()) ||
        (typeof req.body?.restaurantCode === "string" && req.body.restaurantCode.trim()) ||
        "";

      const restaurantCode = safeTrim(restaurantCodeRaw).toLowerCase();
      if (!restaurantCode) {
        return res.status(400).json({ ok: false, error: "Missing restaurantCode" });
      }

      const cfgSnap = await db.ref(`restaurants/${restaurantCode}/config/reputation`).get();
      const cfg = cfgSnap.val() || {};

      const googlePlaceId = safeTrim(cfg.googlePlaceId || "");
      const restaurantDisplayName = safeTrim(cfg.restaurantDisplayName || "");
      const serpSearchQuery =
        safeTrim(req.query?.serpSearchQuery || "") ||
        safeTrim(req.body?.serpSearchQuery || "") ||
        safeTrim(cfg.serpSearchQuery || "");

      const apiKey = SERPAPI_API_KEY.value();

      const resolved = await resolveSerpPlaceIdsFromGooglePlaceId({
        googlePlaceId,
        apiKey,
        hotelDisplayName: restaurantDisplayName,
        serpSearchQuery,
      });

      if (!resolved.serpDataId) {
        return res.json({
          ok: false,
          restaurantCode,
          googlePlaceId,
          serpDataCid: resolved.serpDataCid || "",
          title: resolved.serpResolvedTitle || "",
          resolveMethod: resolved.resolveMethod || "",
          debugLocalCount: resolved.debugLocalCount || 0,
          debugFirstTitle: resolved.debugFirstTitle || "",
          debugFirstAddress: resolved.debugFirstAddress || "",
          debugTopLevelKeys: resolved.debugTopLevelKeys || [],
          error: "No serpDataId returned from SerpAPI place lookup",
        });
      }

      await db.ref(`restaurants/${restaurantCode}/config/reputation`).update({
        googlePlaceId: googlePlaceId || "",
        serpDataId: resolved.serpDataId,
        serpDataCid: resolved.serpDataCid || "",
        serpResolvedTitle: resolved.serpResolvedTitle || "",
        serpResolvedAtMs: Date.now(),
        serpResolveMethod: resolved.resolveMethod || "",
      });

      return res.json({
        ok: true,
        restaurantCode,
        googlePlaceId,
        serpDataId: resolved.serpDataId,
        serpDataCid: resolved.serpDataCid || "",
        title: resolved.serpResolvedTitle || "",
      });
    } catch (err) {
      console.error("resolveSerpDataIdForRestaurant error:", err);
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  }
);

/* --------------------------- syncSerpReviewsForHotel (Phase 1 ingestion) --------------------------- */

exports.syncSerpReviewsForHotel = onRequest(
  { region: "us-central1", timeoutSeconds: 180, memory: "512MiB", secrets: [SERPAPI_API_KEY] },
  async (req, res) => {
    setCors(res);
    if (req.method === "OPTIONS") return res.status(204).send("");

    try {
      const hotelCodeRaw =
        (typeof req.query.hotelCode === "string" && req.query.hotelCode.trim()) ||
        (typeof req.body?.hotelCode === "string" && req.body.hotelCode.trim()) ||
        "";

      const hotelCode = normalizeHotelCode(hotelCodeRaw);
      if (!hotelCode) return res.status(400).json({ ok: false, error: "Missing hotelCode" });

      const hl = safeTrim(req.query.hl || req.body?.hl || "en") || "en";

      const maxPagesRaw = safeTrim(req.query.maxPages || req.body?.maxPages || "8");
      const maxPages = Math.max(1, Math.min(Number(maxPagesRaw) || 8, 20));

      const nowMs = Date.now();
      const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
      const cutoffMs = nowMs - thirtyDaysMs;

      const configSnap = await db.ref(`hotels/${hotelCode}/config/reputation`).get();
      const config = configSnap.val() || {};

const serpDataId =
  safeTrim(req.query?.dataId || "") ||
  safeTrim(req.body?.dataId || "") ||
  safeTrim(config.serpDataId || "");

const placeId = safeTrim(config.googlePlaceId || "");

if (!serpDataId && !placeId) {
  return res.status(400).json({
    ok: false,
    error: "Missing config.reputation.serpDataId and googlePlaceId",
  });
}

if (config.active === false) {
  return res.status(400).json({ ok: false, error: "Reputation config inactive" });
}

      const apiKey = SERPAPI_API_KEY.value();

      // MVP: clear & repopulate
      const basePath = `hotels/${hotelCode}/reputation/serpapi`;
      await db.ref(`${basePath}/reviews`).set(null);

    const { reviews, pagesFetched } = await fetchSerpApiReviews({
  apiKey,
  dataId: serpDataId,
  placeId,
  hl,
  maxPages,
});

      let fetchedReviews = 0;
      let storedReviews = 0;
      let skippedOld = 0;
      let skippedNoDate = 0;
      let skippedNoText = 0;

      const updates = {};
      for (const r of reviews) {
        fetchedReviews++;

        const iso = r?.iso_date || r?.iso_date_of_last_edit || "";
        const dateMs = toMsFromIso(iso);
        if (!dateMs) {
          skippedNoDate++;
          continue;
        }

        if (dateMs < cutoffMs) {
          skippedOld++;
          continue;
        }

        const text = (r?.text || r?.snippet || r?.extracted_snippet?.original || "").toString().trim();
        if (!text) {
          skippedNoText++;
          continue;
        }

        const reviewId = sanitizeDbKey(r?.review_id || `serp_${r?.user?.name || "anon"}_${iso || Date.now()}`);

        updates[`${basePath}/reviews/${reviewId}`] = {
          reviewId,
          source: safeTrim(r?.source || "Google"),
          rating: typeof r?.rating === "number" ? r.rating : null,
          dateMs,
          isoDate: safeTrim(iso),
          authorName: safeTrim(r?.user?.name || ""),
          authorLink: safeTrim(r?.user?.link || ""),
          snippet: safeTrim(r?.snippet || ""),
          text,
          language: hl,
          likes: typeof r?.likes === "number" ? r.likes : 0,
          hasResponse: !!r?.response,
          responseText: safeTrim(r?.response?.extracted_snippet?.original || r?.response?.snippet || ""),
          fetchedAtMs: nowMs,
          raw: {
            position: r?.position ?? null,
            link: safeTrim(r?.link || ""),
            details: r?.details || null,
          },
        };

        storedReviews++;
      }

      if (Object.keys(updates).length > 0) await db.ref().update(updates);

      const lastSync = {
        ok: true,
        hotelCode,
        placeId,
        hl,
        maxPages,
        pagesFetched,
        fetchedReviews,
        storedReviews,
        skippedOld,
        skippedNoDate,
        skippedNoText,
        cutoffMs,
        cutoffIso: new Date(cutoffMs).toISOString(),
        fetchedAtMs: nowMs,
        fetchedAtIso: new Date(nowMs).toISOString(),
        note: "SerpAPI google_maps_reviews newestFirst; stored only last 30 days; stored only reviews with text",
      };

      await db.ref(`${basePath}/meta`).set(lastSync);
      return res.json(lastSync);
    } catch (e) {
      console.error("syncSerpReviewsForHotel error:", e);
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  }
);


/* --------------------------- detect rerstaurant theemes --------------------------- */

function detectThemesForRestaurantReview(text) {
  const t = normalizeText(text);
  const themes = [];
  const has = (...phrases) => phrases.some((p) => t.includes(p));

  if (
    has(
      "delicious",
      "tasty",
      "bland",
      "salty",
      "flavorless",
      "awful food",
      "bad food",
      "great food",
      "excellent food",
      "food was amazing",
      "food was terrible",
      "not good",
      "disgusting"
    )
  ) themes.push("food_quality_taste");

  if (
    has(
      "cold food",
      "food was cold",
      "lukewarm",
      "stale",
      "not fresh",
      "fresh food",
      "burnt",
      "overcooked",
      "undercooked",
      "raw inside",
      "soggy"
    )
  ) themes.push("food_temperature_freshness");

  if (
    has(
      "wrong order",
      "missing item",
      "forgot",
      "order was wrong",
      "incorrect order",
      "not what i ordered",
      "missing sauce",
      "missing fries",
      "missing drink",
      "missing food"
    )
  ) themes.push("order_accuracy");

  if (
    has(
      "slow service",
      "long wait",
      "waited",
      "took forever",
      "too long",
      "late order",
      "delayed",
      "slow staff",
      "slow kitchen",
      "line was long"
    )
  ) themes.push("service_speed");

  if (
    has(
      "friendly staff",
      "great staff",
      "rude staff",
      "unfriendly",
      "bad service",
      "excellent service",
      "poor service",
      "helpful staff",
      "customer service",
      "staff was rude",
      "manager was rude"
    )
  ) themes.push("staff_friendliness");

  if (
    has(
      "dirty",
      "unclean",
      "filthy",
      "gross",
      "smelled bad",
      "bad smell",
      "washroom dirty",
      "bathroom dirty",
      "sticky table",
      "messy",
      "unsanitary"
    )
  ) themes.push("cleanliness_hygiene");

  if (
    has(
      "too expensive",
      "overpriced",
      "not worth it",
      "bad value",
      "good value",
      "pricey",
      "expensive for what it is",
      "rip off",
      "portion too small for the price"
    )
  ) themes.push("value_pricing");

  if (
    has(
      "small portion",
      "tiny portion",
      "portion was small",
      "huge portion",
      "generous portion",
      "inconsistent portion",
      "less food than usual"
    )
  ) themes.push("portion_size_consistency");

  if (
    has(
      "pickup",
      "pick up",
      "takeout",
      "take-out",
      "ready when i arrived",
      "wasn't ready",
      "pickup order",
      "takeout order"
    )
  ) themes.push("takeout_pickup_experience");

  if (
    has(
      "delivery",
      "delivered late",
      "driver",
      "uber eats",
      "doordash",
      "skip the dishes",
      "skip dishes",
      "courier",
      "arrived late"
    )
  ) themes.push("delivery_experience");

  if (
    has(
      "packaging",
      "spilled",
      "leaking",
      "crushed",
      "damaged",
      "container broke",
      "bag ripped",
      "poor packaging"
    )
  ) themes.push("packaging_item_condition");

  if (
    has(
      "catering",
      "event order",
      "large order",
      "tray order",
      "corporate lunch",
      "party order",
      "catered"
    )
  ) themes.push("catering_execution_reliability");

  if (
    has(
      "loud",
      "noisy",
      "too noisy",
      "comfortable",
      "nice atmosphere",
      "bad atmosphere",
      "music too loud",
      "crowded",
      "seating"
    )
  ) themes.push("atmosphere_noise_comfort");

  if (
    has(
      "out of stock",
      "sold out",
      "didn't have",
      "unavailable",
      "not available",
      "ran out",
      "menu item unavailable"
    )
  ) themes.push("menu_availability_stock");

  return Array.from(new Set(themes));
}

const RESTAURANT_THEME_META = {
  food_quality_taste: { title: "Food quality / taste", bucket: "ops" },
  food_temperature_freshness: { title: "Food temperature / freshness", bucket: "ops" },
  order_accuracy: { title: "Order accuracy", bucket: "ops" },
  service_speed: { title: "Service speed / wait time", bucket: "ops" },
  staff_friendliness: { title: "Staff friendliness / hospitality", bucket: "ops" },
  cleanliness_hygiene: { title: "Cleanliness / hygiene", bucket: "ops" },
  value_pricing: { title: "Value / pricing perception", bucket: "brand" },
  portion_size_consistency: { title: "Portion size / consistency", bucket: "product" },
  takeout_pickup_experience: { title: "Takeout / pickup experience", bucket: "ops" },
  delivery_experience: { title: "Delivery experience", bucket: "ops" },
  packaging_item_condition: { title: "Packaging / item condition", bucket: "ops" },
  catering_execution_reliability: { title: "Catering execution / reliability", bucket: "ops" },
  atmosphere_noise_comfort: { title: "Atmosphere / noise / comfort", bucket: "brand" },
  menu_availability_stock: { title: "Menu availability / stock issues", bucket: "ops" },
};

/*  get recent voice complaints for vapi */

async function getRecentVoiceComplaintSignals(restaurantCode, { windowDays = 30 } = {}) {
  const nowMs = Date.now();
  const cutoffMs = nowMs - windowDays * 24 * 60 * 60 * 1000;

  const snap = await db
    .ref(`restaurants/${restaurantCode}/reputationSignals/voiceComplaints/items`)
    .get();

  const obj = snap.val() || {};

  return Object.values(obj)
    .map((x) => x || {})
    .filter((x) => {
      const dateMs =
        typeof x.dateMs === "number"
          ? x.dateMs
          : typeof x.createdAtMs === "number"
          ? x.createdAtMs
          : null;

      return dateMs != null && dateMs >= cutoffMs;
    });
}


/* --------------------------- Restaurant Reputation Phase 1 Builder --------------------------- */

async function buildRestaurantReputationPhase1Report({ restaurantCode, restaurantDisplayName, reviews, apiKey }) {
  const nowMs = Date.now();
  const windowMs = 90 * 24 * 60 * 60 * 1000;
  const startMs = nowMs - windowMs;

  const norm = (Array.isArray(reviews) ? reviews : [])
    .map((r) => r || {})
    .map((r) => ({
      reviewId: safeTrim(r.reviewId || r.review_id || ""),
      source: safeTrim(r.source || "Google"),
      authorName: safeTrim(r.authorName || r?.user?.name || ""),
      isoDate: safeTrim(r.isoDate || r.iso_date || ""),
      dateMs: typeof r.dateMs === "number" ? r.dateMs : null,
      rating: typeof r.rating === "number" ? r.rating : null,
      text: safeTrim(r.text || r.snippet || ""),
    }))
    .filter((r) => !!r.text)
    .filter((r) => r.dateMs != null && r.dateMs >= startMs);

  const totalTextReviews = norm.length;

  const buckets = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let ratingSum = 0;
  let ratingCount = 0;

  const last7dStart = nowMs - 7 * 24 * 60 * 60 * 1000;
  let last7dReviews = 0;
  let prior23dReviews = 0;

  for (const r of norm) {
    if (r.rating != null && buckets[String(r.rating)] != null) buckets[String(r.rating)] += 1;

    if (r.rating != null) {
      ratingSum += r.rating;
      ratingCount += 1;
    }

    if (r.dateMs >= last7dStart) last7dReviews += 1;
    else prior23dReviews += 1;
  }

  const avgRating = ratingCount ? Number((ratingSum / ratingCount).toFixed(2)) : null;
  const oneStar = buckets["1"] || 0;

  const themeAgg = {};

  function addTheme(themeId, r) {
    if (!themeAgg[themeId]) {
      themeAgg[themeId] = {
        themeId,
        title: RESTAURANT_THEME_META?.[themeId]?.title || themeId,
        bucket: RESTAURANT_THEME_META?.[themeId]?.bucket || "unknown",
        mentions: 0,
        mentionsLast7d: 0,
        mentionsPrior23d: 0,
        oneTwoStarMentions: 0,
        examples: [],
      };
    }

    const a = themeAgg[themeId];

    a.mentions += 1;

    if (r.rating != null && r.rating <= 2) a.oneTwoStarMentions += 1;

    if (r.dateMs >= last7dStart) a.mentionsLast7d += 1;
    else a.mentionsPrior23d += 1;

    if (a.examples.length < 4) {
      a.examples.push({
        reviewId: r.reviewId || "",
        rating: r.rating,
        isoDate: r.isoDate || "",
        quote: pickQuote(r.text, 220),
      });
    }
  }

  for (const r of norm) {
    const themes = detectThemesForRestaurantReview(r.text);
    for (const th of themes) addTheme(th, r);
  }

  const themesArr = Object.values(themeAgg)
    .map((t) => {
      const rateLast7d = last7dReviews ? t.mentionsLast7d / last7dReviews : 0;
      const ratePrior = prior23dReviews ? t.mentionsPrior23d / prior23dReviews : 0;

      const trend = Number((rateLast7d - ratePrior).toFixed(3));

      const severity = t.mentions
        ? Number((t.oneTwoStarMentions / t.mentions).toFixed(2))
        : 0;

      return {
        ...t,
        rateLast7d: Number(rateLast7d.toFixed(3)),
        ratePrior23d: Number(ratePrior.toFixed(3)),
        trend7dVsPrior: trend,
        severity,
      };
    })
    .sort((a, b) => {
      if (b.trend7dVsPrior !== a.trend7dVsPrior)
        return b.trend7dVsPrior - a.trend7dVsPrior;

      if (b.severity !== a.severity) return b.severity - a.severity;

      return b.mentions - a.mentions;
    })
    .slice(0, 10);

  const sampleRecent = [...norm]
    .sort((a, b) => (b.dateMs || 0) - (a.dateMs || 0))
    .slice(0, 6)
    .map((r) => ({
      reviewId: r.reviewId,
      authorName: r.authorName,
      isoDate: r.isoDate,
      dateMs: r.dateMs,
      rating: r.rating,
      source: r.source,
      text: pickQuote(r.text, 380),
    }));

  const oneStarRatio = totalTextReviews ? oneStar / totalTextReviews : 0;

  let riskRule = "MEDIUM";

  if (avgRating != null) {
    if (avgRating <= 3.0 || oneStarRatio >= 0.35) riskRule = "HIGH";
    else if (avgRating >= 4.2 && oneStarRatio <= 0.10) riskRule = "LOW";
  }

  const themeBrief = themesArr.map((t) => ({
    themeId: t.themeId,
    title: t.title,
    bucket: t.bucket,
    mentions: t.mentions,
    trend7dVsPrior: t.trend7dVsPrior,
    severity: t.severity,
    examples: t.examples,
  }));

  const reviewBrief = sampleRecent.map((r) => ({
    rating: r.rating,
    isoDate: r.isoDate,
    text: r.text,
  }));

  let gpt = null;
  let gptMeta = { ok: false, reason: "not_called" };

  if (apiKey) {
    const prompt = [
      "You are a restaurant reputation analyst.",
      "You will receive ONLY last-30-days written restaurant reviews.",
      "Return ONLY valid minified JSON.",
      "",
      "Answer using ONLY provided evidence:",
      "1) consistentComplaints",
      "2) risingTheme",
      "3) brandDamage",
      "4) fixImmediately",
      "5) requiresCapital",
      "6) noiseVsSystemic",
      "7) reputationRiskLevel",
      "",
      "Restaurant:",
      restaurantDisplayName || restaurantCode,
      "",
      "Theme signals:",
      JSON.stringify(themeBrief),
      "",
      "Recent excerpts:",
      JSON.stringify(reviewBrief),
      "",
      "Output schema:",
      '{"answers":{"consistentComplaints":"","risingTheme":"","brandDamage":"","fixImmediately":[],"requiresCapital":[],"noiseVsSystemic":{"emotionalNoise":[],"systemicIssues":[]},"reputationRiskLevel":"MEDIUM","riskRationale":""},"recommendations":{"next7Days":[],"next30Days":[],"ownerLevelCapex":[]}}',
    ].join("\n");

    try {
      gpt = await openaiJson({
        apiKey,
        model: "gpt-5.2",
        prompt,
        reasoningEffort: "low",
      });

      gptMeta = { ok: true };
    } catch (e) {
      gptMeta = { ok: false, reason: String(e?.message || e).slice(0, 200) };
    }
  }

  const answers = gpt?.answers || {
    consistentComplaints: "Not generated.",
    risingTheme: "Not generated.",
    brandDamage: "Not generated.",
    fixImmediately: [],
    requiresCapital: [],
    noiseVsSystemic: { emotionalNoise: [], systemicIssues: [] },
    reputationRiskLevel: riskRule,
    riskRationale: `Rule-based fallback: avgRating=${avgRating}, oneStarRatio=${Number(
      oneStarRatio.toFixed(2)
    )}`,
  };

  const riskFinal = ["LOW", "MEDIUM", "HIGH"].includes(
    answers.reputationRiskLevel
  )
    ? answers.reputationRiskLevel
    : riskRule;

  answers.reputationRiskLevel = riskFinal;

  return {
    ok: true,
    restaurantCode,
    restaurantDisplayName: restaurantDisplayName || "",
    window: { label: "Last 90 days", startMs, endMs: nowMs },
    counts: {
      totalTextReviews,
      avgRating,
      ratingBuckets: buckets,
      oneStar,
      oneStarRatio: Number(oneStarRatio.toFixed(2)),
      last7dReviews,
      prior23dReviews,
    },
    themes: themesArr,
    sampleRecent,
    answers,
    recommendations:
      gpt?.recommendations || { next7Days: [], next30Days: [], ownerLevelCapex: [] },
    ops: {
      generatedAtMs: nowMs,
      source: "serpapi_google_maps_reviews",
      model: "gpt-5.2",
      gptMeta,
      riskRule,
    },
  };
}

/* --------------------------- Restaurant Reputation Phase 2 Builder (Trend + Heatmap) --------------------------- */

async function buildRestaurantReputationPhase2Report({
  restaurantCode,
  restaurantDisplayName,
  reviews,
  apiKey,
  restaurantTimeZone = "America/Toronto",
}) {
  const nowMs = Date.now();
  const windowMs = 90 * 24 * 60 * 60 * 1000;
  const startMs = nowMs - windowMs;

  const last7dStart = nowMs - 7 * 24 * 60 * 60 * 1000;

  const norm = (Array.isArray(reviews) ? reviews : [])
    .map((r) => r || {})
    .map((r) => ({
      reviewId: safeTrim(r.reviewId || r.review_id || ""),
      source: safeTrim(r.source || "Google"),
      authorName: safeTrim(r.authorName || r?.user?.name || ""),
      isoDate: safeTrim(r.isoDate || r.iso_date || ""),
      dateMs: typeof r.dateMs === "number" ? r.dateMs : null,
      rating: typeof r.rating === "number" ? r.rating : null,
      text: safeTrim(r.text || r.snippet || ""),
      hasResponse: !!r.hasResponse,
      responseText: safeTrim(r.responseText || ""),
    }))
    .filter((r) => r.dateMs != null)
    .filter((r) => r.dateMs >= startMs && r.dateMs <= nowMs)
    .filter((r) => !!r.text);

  const dayKeys = [];
  for (let i = 29; i >= 0; i--) {
    const ms = nowMs - i * 24 * 60 * 60 * 1000;
    dayKeys.push(dayKeyFromMs(ms, restaurantTimeZone));
  }

  const heatmap = {};
  const themeAgg = {};

  let totalTextReviews = 0;
  let ratingSum = 0;
  let ratingCount = 0;
  let last7dReviews = 0;
  let prior23dReviews = 0;

  const buckets = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };

    const voiceComplaints = await getRecentVoiceComplaintSignals(restaurantCode, {
    windowDays: 30,
  });

  console.log(
  "voiceComplaints sample:",
  JSON.stringify((voiceComplaints || []).slice(0, 3), null, 2)
);

  const complaintTrends = buildRestaurantComplaintTrends({
    reviewItems: (norm || []).map((r) => ({
      text: r?.text || "",
    })),
  callItems: (voiceComplaints || []).map((c) => ({
    transcript:
      c?.text ||
      c?.transcript ||
      c?.summary ||
      c?.complaintText ||
      "",
    })),
    messageItems: [],
  });

  for (const r of norm) {
    totalTextReviews++;

    if (r.rating != null && buckets[String(r.rating)] != null) {
      buckets[String(r.rating)] += 1;
    }

    if (r.rating != null) {
      ratingSum += r.rating;
      ratingCount += 1;
    }

    if (r.dateMs >= last7dStart) last7dReviews += 1;
    else prior23dReviews += 1;

    const themes = detectThemesForRestaurantReview(r.text);
    const dk = dayKeyFromMs(r.dateMs, restaurantTimeZone);

    for (const th of themes) {
      if (!heatmap[th]) heatmap[th] = {};
      heatmap[th][dk] = (heatmap[th][dk] || 0) + 1;

      if (!themeAgg[th]) {
        themeAgg[th] = {
          themeId: th,
          title: RESTAURANT_THEME_META?.[th]?.title || th,
          bucket: RESTAURANT_THEME_META?.[th]?.bucket || "unknown",
          mentions: 0,
          mentionsLast7d: 0,
          mentionsPrior23d: 0,
          oneTwoStarMentions: 0,
          examples: [],
        };
      }

      const a = themeAgg[th];
      a.mentions += 1;

      if (r.rating != null && r.rating <= 2) a.oneTwoStarMentions += 1;

      if (r.dateMs >= last7dStart) a.mentionsLast7d += 1;
      else a.mentionsPrior23d += 1;

      if (a.examples.length < 4) {
        a.examples.push({
          reviewId: r.reviewId || "",
          rating: r.rating,
          isoDate: r.isoDate || "",
          quote: pickQuote(r.text, 220),
        });
      }
    }
  }

  const avgRating = ratingCount ? Number((ratingSum / ratingCount).toFixed(2)) : null;
  const oneStar = buckets["1"] || 0;
  const oneStarRatio = totalTextReviews ? oneStar / totalTextReviews : 0;

  let riskRule = "MEDIUM";
  if (avgRating != null) {
    if (avgRating <= 3.0 || oneStarRatio >= 0.35) riskRule = "HIGH";
    else if (avgRating >= 4.2 && oneStarRatio <= 0.10) riskRule = "LOW";
  }

  const themesArr = Object.values(themeAgg)
    .map((t) => {
      const rateLast7d = last7dReviews ? t.mentionsLast7d / last7dReviews : 0;
      const ratePrior = prior23dReviews ? t.mentionsPrior23d / prior23dReviews : 0;
      const trend = Number((rateLast7d - ratePrior).toFixed(3));
      const severity = t.mentions
        ? Number((t.oneTwoStarMentions / t.mentions).toFixed(2))
        : 0;

      return {
        ...t,
        rateLast7d: Number(rateLast7d.toFixed(3)),
        ratePrior23d: Number(ratePrior.toFixed(3)),
        trend7dVsPrior: trend,
        severity,
      };
    })
    .sort((a, b) => {
      if (b.trend7dVsPrior !== a.trend7dVsPrior) return b.trend7dVsPrior - a.trend7dVsPrior;
      if (b.severity !== a.severity) return b.severity - a.severity;
      return b.mentions - a.mentions;
    });

  const risingThemes = themesArr
    .filter((t) => (t.mentionsLast7d || 0) >= 2)
    .filter((t) => (t.trend7dVsPrior || 0) >= 0.05)
    .slice(0, 8)
    .map((t) => ({
      themeId: t.themeId,
      title: t.title,
      bucket: t.bucket,
      mentions: t.mentions,
      mentionsLast7d: t.mentionsLast7d,
      mentionsPrior23d: t.mentionsPrior23d,
      trend7dVsPrior: t.trend7dVsPrior,
      severity: t.severity,
      examples: t.examples,
    }));

  const topThemes = themesArr.slice(0, 10).map((t) => ({
    themeId: t.themeId,
    title: t.title,
    bucket: t.bucket,
    mentions: t.mentions,
    trend7dVsPrior: t.trend7dVsPrior,
    severity: t.severity,
    examples: t.examples,
  }));

  const topThemeIds = topThemes.map((t) => t.themeId);
  const heatmapTop = {};

  for (const th of topThemeIds) {
    heatmapTop[th] = {};
    for (const dk of dayKeys) {
      heatmapTop[th][dk] = Number(heatmap?.[th]?.[dk] || 0);
    }
  }

  const sampleRecent = [...norm]
    .sort((a, b) => (b.dateMs || 0) - (a.dateMs || 0))
    .slice(0, 8)
    .map((r) => ({
      reviewId: r.reviewId,
      isoDate: r.isoDate,
      dateMs: r.dateMs,
      rating: r.rating,
      source: r.source,
      text: pickQuote(r.text, 360),
    }));

  let gpt = null;
  let gptMeta = { ok: false, reason: "not_called" };

  if (apiKey && totalTextReviews > 0) {
    const prompt = [
      "You are a restaurant reputation analyst for an operator.",
      "Use ONLY the provided evidence. Do NOT invent facts.",
      "Return ONLY valid minified JSON. No markdown. No extra text.",
      "",
      "You will receive:",
      "- Rising themes (last 7 days vs prior 23 days)",
      "- Top themes + examples",
      "- Recent review excerpts",
      "",
      "Return JSON with EXACTLY these keys:",
      '{"executiveSummary":"","whatChangedThisWeek":"","topRisks":[],"topFixesNoCapex":[],"capexNeeded":[],"recommendedOwnerActions7d":[],"recommendedOwnerActions30d":[],"riskLevel":"MEDIUM","riskRationale":""}',
      "",
      `Restaurant: ${restaurantDisplayName || restaurantCode}`,
      `RestaurantCode: ${restaurantCode}`,
      "",
      "RisingThemes:",
      JSON.stringify(risingThemes),
      "",
      "TopThemes:",
      JSON.stringify(topThemes),
      "",
      "RecentExcerpts:",
      JSON.stringify(sampleRecent),
    ].join("\n");

    try {
      gpt = await openaiJson({
        apiKey,
        model: "gpt-5.2",
        prompt,
        reasoningEffort: "low",
      });
      gptMeta = { ok: true };
    } catch (e) {
      gptMeta = { ok: false, reason: String(e?.message || e).slice(0, 200) };
    }
  }

const riskLevelFinal =
  ["LOW", "MEDIUM", "HIGH"].includes(gpt?.riskLevel) ? gpt.riskLevel : riskRule;

function buildComplaintAlerts(complaintTrends) {
  const alerts = [];

  const counts = complaintTrends?.counts || {};

  if ((counts.FOOD_QUALITY || 0) >= 2) {
    alerts.push({
      type: "FOOD_QUALITY_SPIKE",
      severity: "HIGH",
      message: "Multiple recent complaints about food quality detected",
    });
  }

  if ((counts.VALUE_PRICING || 0) >= 2) {
    alerts.push({
      type: "VALUE_DROP",
      severity: "MEDIUM",
      message: "Guests are complaining about value/price vs portion",
    });
  }

  if ((counts.SERVICE || 0) >= 2) {
    alerts.push({
      type: "SERVICE_ISSUES",
      severity: "MEDIUM",
      message: "Recurring service complaints detected",
    });
  }

  return alerts;
}

return {
    ok: true,
    restaurantCode,
    restaurantDisplayName: restaurantDisplayName || "",
    window: { label: "Last 90 days", startMs, endMs: nowMs, timeZone: restaurantTimeZone },
    counts: {
      totalTextReviews,
      avgRating,
      ratingBuckets: buckets,
      oneStar,
      oneStarRatio: Number(oneStarRatio.toFixed(2)),
      last7dReviews,
      prior23dReviews,
    },
    trend: {
      risingThemes,
      topThemes,
      riskRule,
      riskLevel: riskLevelFinal,
    },

    alerts: buildComplaintAlerts(complaintTrends),

    heatmap: {
      dayKeys,
      themes: heatmapTop,
      themeMeta: Object.fromEntries(
        topThemes.map((t) => [t.themeId, { title: t.title, bucket: t.bucket }])
      ),
      note: "Heatmap includes only top themes to keep payload small.",
    },
    sampleRecent,
    evidence: sampleRecent,
    complaintTrends,
    narrative: gpt
      ? {
          executiveSummary: safeTrim(gpt.executiveSummary),
          whatChangedThisWeek: safeTrim(gpt.whatChangedThisWeek),
          topRisks: Array.isArray(gpt.topRisks) ? gpt.topRisks : [],
          topFixesNoCapex: Array.isArray(gpt.topFixesNoCapex) ? gpt.topFixesNoCapex : [],
          capexNeeded: Array.isArray(gpt.capexNeeded) ? gpt.capexNeeded : [],
          recommendedOwnerActions7d: Array.isArray(gpt.recommendedOwnerActions7d)
            ? gpt.recommendedOwnerActions7d
            : [],
          recommendedOwnerActions30d: Array.isArray(gpt.recommendedOwnerActions30d)
            ? gpt.recommendedOwnerActions30d
            : [],
          riskLevel: riskLevelFinal,
          riskRationale:
            safeTrim(gpt.riskRationale) ||
            `Rule fallback: avgRating=${avgRating}, oneStarRatio=${Number(oneStarRatio.toFixed(2))}`,
        }
      : {
          executiveSummary: "",
          whatChangedThisWeek: "",
          topRisks: [],
          topFixesNoCapex: [],
          capexNeeded: [],
          recommendedOwnerActions7d: [],
          recommendedOwnerActions30d: [],
          riskLevel: riskLevelFinal,
          riskRationale: `Rule fallback: avgRating=${avgRating}, oneStarRatio=${Number(
            oneStarRatio.toFixed(2)
          )}`,
        },
    ops: {
      generatedAtMs: nowMs,
      source: "serpapi_google_maps_reviews",
      model: "gpt-5.2",
      gptMeta,
    },
  };
}

/* --------------------------- REBUILD Restaurant Reputation Phase 1 --------------------------- */

exports.rebuildRestaurantReputationPhase1 = onRequest(
  { region: "us-central1", secrets: [OPENAI_API_KEY], timeoutSeconds: 300, memory: "1GiB" },
  async (req, res) => {
    setCors(res);
    if (req.method === "OPTIONS") return res.status(204).send("");

    try {
      const restaurantCodeRaw =
        (typeof req.query.restaurantCode === "string" && req.query.restaurantCode.trim()) ||
        (typeof req.body?.restaurantCode === "string" && req.body.restaurantCode.trim()) ||
        "";

      const restaurantCode = safeTrim(restaurantCodeRaw).toLowerCase();
      if (!restaurantCode) {
        return res.status(400).json({ ok: false, error: "restaurantCode query param required" });
      }

      const nowMs = Date.now();
      const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
      const cutoffMs = nowMs - thirtyDaysMs;

      const cfgSnap = await db.ref(`restaurants/${restaurantCode}/config/reputation`).get();
      const cfg = cfgSnap.val() || {};
      const restaurantDisplayName = safeTrim(cfg.restaurantDisplayName || "");

      const reviewsSnap = await db.ref(`restaurants/${restaurantCode}/reputation/serpapi/reviews`).get();
      const reviewsObj = reviewsSnap.val() || {};
      const reviews = Object.values(reviewsObj);

      const textOnlyRecent = (Array.isArray(reviews) ? reviews : [])
        .map((r) => r || {})
        .filter((r) => {
          const text = safeTrim(r.text || r.snippet || "");
          const dateMs = typeof r.dateMs === "number" ? r.dateMs : null;
          if (!text) return false;
          if (!dateMs) return false;
          return dateMs >= cutoffMs;
        });

      const apiKey = OPENAI_API_KEY.value();

      const report = await buildRestaurantReputationPhase1Report({
        restaurantCode,
        restaurantDisplayName,
        reviews: textOnlyRecent,
        apiKey,
      });

      const outPath = `restaurants/${restaurantCode}/insights/reputationPhase1`;
      await db.ref(outPath).set(report);

      return res.json({
        ok: true,
        restaurantCode,
        path: outPath,
        storedReviewCount: textOnlyRecent.length,
        generatedAtMs: Date.now(),
      });
    } catch (err) {
      console.error("rebuildRestaurantReputationPhase1 error:", err);
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  }
);

/* --------------------------- Review Response Helpers --------------------------- */

function normalizeReviewText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function isNegativeReview(review) {
  const rating = Number(review?.rating || 0);
  return rating === 1 || rating === 2;
}

function makeStableReviewId(review, idx = 0) {
  const existing =
    review?.reviewId ||
    review?.id ||
    review?.review_id ||
    review?.reviewToken ||
    "";

  if (existing) return String(existing);

  const raw = JSON.stringify({
    source: review?.source || "google",
    rating: Number(review?.rating || 0),
    text: normalizeReviewText(review?.text || review?.snippet || ""),
    date:
      review?.date ||
      review?.publishedAt ||
      review?.published_at ||
      review?.time ||
      "",
    idx,
  });

  return "review_" + crypto.createHash("md5").update(raw).digest("hex");
}

function detectIssueTagsForReview(reviewText) {
  const text = normalizeReviewText(reviewText).toLowerCase();
  if (!text) return [];

  const tags = new Set();

  if (/(cold|burnt|raw|stale|bland|salty|taste|flavour|flavor|portion|quality|fresh)/i.test(text)) {
    tags.add("FOOD_QUALITY");
  }

  if (/(rude|staff|service|ignored|attitude|unfriendly|server|cashier)/i.test(text)) {
    tags.add("STAFF_SERVICE");
  }

  if (/(late|slow|wait|waiting|delay|took forever|never arrived)/i.test(text)) {
    tags.add("SPEED_OF_SERVICE");
  }

  if (/(wrong order|missing|forgot|incorrect|mixed up)/i.test(text)) {
    tags.add("ORDER_ACCURACY");
  }

  if (/(dirty|clean|messy|washroom|bathroom|table|floor)/i.test(text)) {
    tags.add("CLEANLINESS");
  }

  if (/(expensive|overpriced|price|value|cost)/i.test(text)) {
    tags.add("VALUE");
  }

  if (/(delivery|driver|courier|pickup|pick up|takeout|take-out)/i.test(text)) {
    tags.add("DELIVERY_OR_PICKUP");
  }

  return Array.from(tags).slice(0, 5);
}

async function buildReviewResponses({
  restaurantCode,
  restaurantDisplayName,
  reviews,
  apiKey,
  db,
}) {
  const now = Date.now();
  const allReviews = Array.isArray(reviews) ? reviews : [];

const negativeReviews = allReviews
  .filter((r) => isNegativeReview(r))
  .filter((r) => {
    const hasResponseFlag = r?.hasResponse === true;
    const hasResponseText = String(r?.responseText || "").trim().length > 0;
    return !hasResponseFlag && !hasResponseText;
  })
    .map((review, idx) => {
      const text = normalizeReviewText(review?.text || review?.snippet || "");
      const rating = Number(review?.rating || 0);
      const authorName =
        review?.user?.name ||
        review?.user?.username ||
        review?.authorName ||
        review?.author ||
        review?.reviewer ||
        "Customer";

return {
  reviewId: makeStableReviewId(review, idx),
  source: String(review?.source || "google"),
  rating,
  text,
  authorName,
  date:
    review?.date ||
   review?.isoDate ||
    review?.publishedAt ||
    review?.published_at ||
    review?.time ||
    "",
  dateMs:
    review?.dateMs ||
    (review?.isoDate ? new Date(review.isoDate).getTime() : null) ||
    (review?.time ? new Date(review.time).getTime() : null) ||
    null,
    issueTags: detectIssueTagsForReview(text),
    rawReview: review,
};
    })
    .filter((r) => r.text);

  const items = [];

  for (const review of negativeReviews) {
    let draftResponse = "";

    try {
      const prompt = `
You are writing a public-facing response from a restaurant manager to a negative customer review.

Rules:
- Keep the tone calm, professional, warm, and brand-neutral
- Do not be defensive
- Do not argue with the customer
- Acknowledge the issue specifically
- Apologize when appropriate
- Keep it concise: about 70 to 130 words
- Do not offer legal admissions
- Do not promise refunds or compensation
- Optionally invite the guest to continue the conversation offline
- Do not mention internal systems, AI, or classification
- Must work for any restaurant type

Restaurant name:
${restaurantDisplayName || restaurantCode || "the restaurant"}

Review source:
${review.source}

Review rating:
${review.rating} star

Detected issue tags:
${(review.issueTags || []).join(", ") || "none"}

Review date:
${review.date || "unknown"}

Customer review:
"""
${review.text}
"""

Write only the response draft text.
`.trim();

      const openaiRes = await axios.post(
        "https://api.openai.com/v1/chat/completions",
        {
          model: "gpt-4o-mini",
          temperature: 0.4,
          messages: [
            {
              role: "system",
              content:
                "You write safe, professional, concise public review response drafts for restaurants.",
            },
            {
              role: "user",
              content: prompt,
            },
          ],
        },
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          timeout: 45000,
        }
      );

      draftResponse = String(
        openaiRes?.data?.choices?.[0]?.message?.content || ""
      ).trim();
    } catch (err) {
      console.error("buildReviewResponses OpenAI error:", err?.response?.data || err?.message || err);

      draftResponse =
        "Thank you for your feedback. We’re sorry to hear that your experience did not meet expectations. We take comments like yours seriously and are reviewing the concerns you raised so we can improve. We appreciate you bringing this to our attention and would welcome the opportunity to learn more from your experience offline.";
    }

items.push({
  reviewId: review.reviewId,
  source: review.source,
  rating: review.rating,
  text: review.text,
  authorName: review.authorName || "Customer",
  date: review.date || "",
  dateMs: review.dateMs || null,
  issueTags: review.issueTags || [],
  draftResponse,
  createdAtMs: now,
});
  }

  const payload = {
    restaurantCode,
    restaurantDisplayName: restaurantDisplayName || restaurantCode || "",
    generatedAtMs: now,
    totalNegativeReviews: items.length,
    items,
  };

  await db
    .ref(`restaurants/${restaurantCode}/insights/reviewResponses/latest`)
    .set(payload);

  return payload;
}

/* --------------------------- HTTPS: getRestaurantReputationPhase1 --------------------------- */

exports.getRestaurantReputationPhase1 = onRequest({ region: "us-central1" }, async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).send("");

  try {
    const restaurantCodeRaw = safeTrim(req.query?.restaurantCode || "");
    if (!restaurantCodeRaw) {
      return res.status(400).json({ ok: false, error: "restaurantCode required" });
    }

    const restaurantCode = safeTrim(restaurantCodeRaw).toLowerCase();

    const snap = await db.ref(`restaurants/${restaurantCode}/insights/reputationPhase1`).get();
    const val = snap.val();

    if (!val) {
      return res.status(404).json({ ok: false, error: "No reputationPhase1 report found" });
    }

    return res.json({ ok: true, restaurantCode, data: val });
  } catch (err) {
    console.error("getRestaurantReputationPhase1 error:", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

/* --------------------------- REBUILD Restaurant Reputation Phase 2 --------------------------- */
/**
 * Dashboard Refresh should call this.
 * Reads:
 *   restaurants/{restaurantCode}/reputation/serpapi/reviews
 * Writes:
 *   restaurants/{restaurantCode}/insights/reputationPhase2/latest
 *   restaurants/{restaurantCode}/insights/reputationPhase2/history/{YYYY-MM-DD}
 */
exports.rebuildRestaurantReputationPhase2 = onRequest(
  { region: "us-central1", secrets: [OPENAI_API_KEY], timeoutSeconds: 300, memory: "1GiB" },
  async (req, res) => {
    setCors(res);
    if (req.method === "OPTIONS") return res.status(204).send("");

    try {
      const restaurantCodeRaw =
        (typeof req.query.restaurantCode === "string" && req.query.restaurantCode.trim()) ||
        (typeof req.body?.restaurantCode === "string" && req.body?.restaurantCode.trim()) ||
        "";

      const restaurantCode = safeTrim(restaurantCodeRaw).toLowerCase();
      if (!restaurantCode) {
        return res.status(400).json({ ok: false, error: "restaurantCode required" });
      }

      const cfgSnap = await db.ref(`restaurants/${restaurantCode}/config/reputation`).get();
      const cfg = cfgSnap.val() || {};
      const restaurantDisplayName = safeTrim(cfg.restaurantDisplayName || "");
      const restaurantTimeZone =
        safeTrim(cfg.timeZone || "") ||
        (await db.ref(`restaurants/${restaurantCode}/config/timeZone`).get()).val() ||
        "America/Toronto";

      const reviewsSnap = await db.ref(`restaurants/${restaurantCode}/reputation/serpapi/reviews`).get();
      const reviewsObj = reviewsSnap.val() || {};
      const reviews = Object.values(reviewsObj);

      const apiKey = OPENAI_API_KEY.value();

      const report = await buildRestaurantReputationPhase2Report({
        restaurantCode,
        restaurantDisplayName,
        reviews,
        apiKey,
        restaurantTimeZone,
      });

      const nowKey = dayKeyFromMs(Date.now(), restaurantTimeZone);

      const latestPath = `restaurants/${restaurantCode}/insights/reputationPhase2/latest`;
      const histPath = `restaurants/${restaurantCode}/insights/reputationPhase2/history/${sanitizeDbKey(nowKey)}`;

      await db.ref(latestPath).set(report);
      await db.ref(histPath).set({ ...report, snapshotDayKey: nowKey });

      return res.json({
        ok: true,
        restaurantCode,
        written: { latestPath, histPath },
        generatedAtMs: Date.now(),
        totalTextReviews: report?.counts?.totalTextReviews || 0,
        risingThemes: Array.isArray(report?.trend?.risingThemes)
          ? report.trend.risingThemes.length
          : 0,
      });
    } catch (err) {
      console.error("rebuildRestaurantReputationPhase2 error:", err);
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  }
);

/* --------------------------- HTTPS: getRestaurantReputationPhase2 --------------------------- */

exports.getRestaurantReputationPhase2 = onRequest({ region: "us-central1" }, async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).send("");

  try {
    const restaurantCodeRaw = safeTrim(req.query?.restaurantCode || "");
    if (!restaurantCodeRaw) {
      return res.status(400).json({ ok: false, error: "restaurantCode required" });
    }

    const restaurantCode = safeTrim(restaurantCodeRaw).toLowerCase();

    const snap = await db.ref(`restaurants/${restaurantCode}/insights/reputationPhase2/latest`).get();
    const val = snap.val();

    if (!val) {
      return res.status(404).json({ ok: false, error: "No reputationPhase2 report found" });
    }

    return res.json({ ok: true, restaurantCode, data: val });
  } catch (err) {
    console.error("getRestaurantReputationPhase2 error:", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

/* --------------------------- Scheduled: buildReputationPhase2AllRestaurants --------------------------- */
/**
 * Nightly job:
 * - runs full restaurant reputation refresh for each active restaurant
 * - reuses the same logic as refreshRestaurantReputation
 */
exports.buildReputationPhase2AllRestaurants = onSchedule(
  {
    region: "us-central1",
    schedule: "25 3 * * *",
    timeZone: "America/Toronto",
    timeoutSeconds: 540,
    memory: "1GiB",
    secrets: [SERPAPI_API_KEY, OPENAI_API_KEY],
  },
  async () => {
    const restaurantsSnap = await db.ref("restaurants").get();
    const restaurants = restaurantsSnap.val() || {};
    const codes = Object.keys(restaurants);

    const apiKeySerp = SERPAPI_API_KEY.value();
    const apiKeyOpenAI = OPENAI_API_KEY.value();

    for (const restaurantCodeRaw of codes) {
      const restaurantCode = safeTrim(restaurantCodeRaw).toLowerCase();

      try {
        const cfgSnap = await db.ref(`restaurants/${restaurantCode}/config/reputation`).get();
        const cfg = cfgSnap.val() || {};

        if (!cfg?.googlePlaceId) continue;
        if (cfg.active === false) continue;

        await runRestaurantReputationRefresh({
          restaurantCode,
          apiKeySerp,
          apiKeyOpenAI,
        });
      } catch (e) {
        console.error(
          "buildReputationPhase2AllRestaurants error:",
          restaurantCode,
          String(e?.message || e)
        );
      }
    }
  }
);

/* --------------------------- HTTPS: setRestaurantReputationFields (ADMIN) --------------------------- */

exports.setRestaurantReputationFields = onRequest({ region: "us-central1" }, async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).send("");
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "POST only" });
  }

  try {
    const {
      restaurantCode: restaurantCodeRaw,
      googlePlaceId,
      serpDataId,
      serpDataCid,
      serpSearchQuery,
      restaurantDisplayName,
      timeZone,
      active,
    } = req.body || {};

    const restaurantCode = safeTrim(restaurantCodeRaw || "").toLowerCase();

    if (!restaurantCode) {
      return res.status(400).json({ ok: false, error: "restaurantCode required" });
    }

    const updates = {
      updatedAtMs: Date.now(),
    };

    if (googlePlaceId !== undefined) updates.googlePlaceId = safeTrim(googlePlaceId);
    if (serpDataId !== undefined) updates.serpDataId = safeTrim(serpDataId);
    if (serpDataCid !== undefined) updates.serpDataCid = safeTrim(serpDataCid);
    if (serpSearchQuery !== undefined) updates.serpSearchQuery = safeTrim(serpSearchQuery);
    if (restaurantDisplayName !== undefined) {
      updates.restaurantDisplayName = safeTrim(restaurantDisplayName);
    }
    if (timeZone !== undefined) updates.timeZone = safeTrim(timeZone);
    if (active !== undefined) updates.active = active !== false;

    await db.ref(`restaurants/${restaurantCode}/config/reputation`).update(updates);

    return res.json({
      ok: true,
      restaurantCode,
      path: `restaurants/${restaurantCode}/config/reputation`,
      updates,
    });
  } catch (err) {
    console.error("setRestaurantReputationFields error:", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

/* --------------------------- Restaurant Reputation Refresh Helper --------------------------- */

function buildRestaurantComplaintTrends({ reviews = [], voiceComplaints = [] }) {
  const counts = {
    cold_food: 0,
    delivery_delay: 0,
    wrong_order: 0,
    rude_staff: 0,
  };

  const sources = {
    voice: 0,
    google: 0,
    ubereats: 0,
    grubhub: 0,
  };

  const byTypeSource = {
    cold_food: { voice: 0, google: 0, ubereats: 0, grubhub: 0 },
    delivery_delay: { voice: 0, google: 0, ubereats: 0, grubhub: 0 },
    wrong_order: { voice: 0, google: 0, ubereats: 0, grubhub: 0 },
    rude_staff: { voice: 0, google: 0, ubereats: 0, grubhub: 0 },
  };

  const tagCounter = {};
  const examplesByType = {
    cold_food: [],
    delivery_delay: [],
    wrong_order: [],
    rude_staff: [],
  };

  function detectTypes(text) {
    const t = String(text || "").toLowerCase();
    const found = [];

    if (
      t.includes("cold food") ||
      t.includes("food was cold") ||
      t.includes("arrived cold") ||
      t.includes("meal was cold") ||
      t.includes("sandwich was cold") ||
      t.includes("fries were cold") ||
      t.includes("pizza was cold") ||
      (t.includes("cold") && t.includes("food"))
    ) {
      found.push("cold_food");
    }

    if (
      t.includes("late") ||
      t.includes("delay") ||
      t.includes("delayed") ||
      t.includes("took too long") ||
      t.includes("never arrived") ||
      t.includes("delivery took") ||
      t.includes("long wait")
    ) {
      found.push("delivery_delay");
    }

    if (
      t.includes("wrong order") ||
      t.includes("incorrect order") ||
      t.includes("missing item") ||
      t.includes("missing items") ||
      t.includes("forgot") ||
      t.includes("gave me the wrong") ||
      t.includes("order was wrong")
    ) {
      found.push("wrong_order");
    }

    if (
      t.includes("rude") ||
      t.includes("bad attitude") ||
      t.includes("hung up") ||
      t.includes("unprofessional") ||
      t.includes("disrespectful")
    ) {
      found.push("rude_staff");
    }

    return found;
  }

  function pushExample(bucket, text, source) {
    if (!text) return;
    if (bucket.length >= 3) return;
    bucket.push({ text: String(text).slice(0, 220), source });
  }

  function addTag(tag) {
    tagCounter[tag] = (tagCounter[tag] || 0) + 1;
  }

  function normalizeSource(source) {
    const s = String(source || "").toLowerCase();

    if (s.includes("uber")) return "ubereats";
    if (s.includes("grubhub")) return "grubhub";
    if (s.includes("google")) return "google";
    return "google";
  }

  for (const item of voiceComplaints) {
    const text = String(item?.text || item?.transcript || "").trim();
    if (!text) continue;

    sources.voice += 1;

    const types = detectTypes(text);
    for (const type of types) {
      counts[type] += 1;
      byTypeSource[type].voice += 1;
      addTag(type);
      pushExample(examplesByType[type], text, "voice");
    }
  }

  for (const review of reviews) {
    const text = String(review?.text || review?.snippet || "").trim();
    if (!text) continue;

    const src = normalizeSource(review?.source);
    if (sources[src] === undefined) {
      sources.google += 1;
    } else {
      sources[src] += 1;
    }

    const types = detectTypes(text);
    for (const type of types) {
      counts[type] += 1;
      if (byTypeSource[type][src] === undefined) {
        byTypeSource[type].google += 1;
      } else {
        byTypeSource[type][src] += 1;
      }
      addTag(type);
      pushExample(examplesByType[type], text, src);
    }
  }

  const topTags = Object.entries(tagCounter)
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  const topTag = topTags[0]?.tag || null;

  let topPattern = null;
  if (topTag) {
    const sourceMixParts = [];
    const topSources = byTypeSource[topTag];

    if ((topSources?.voice || 0) > 0) sourceMixParts.push(`Phone ${topSources.voice}`);
    if ((topSources?.google || 0) > 0) sourceMixParts.push(`Google ${topSources.google}`);
    if ((topSources?.ubereats || 0) > 0) sourceMixParts.push(`Uber Eats ${topSources.ubereats}`);
    if ((topSources?.grubhub || 0) > 0) sourceMixParts.push(`Grubhub ${topSources.grubhub}`);

    const titleMap = {
      cold_food: "Cold food complaints are emerging",
      delivery_delay: "Delivery delay complaints are emerging",
      wrong_order: "Wrong order complaints are emerging",
      rude_staff: "Rude staff complaints are emerging",
    };

    const summaryMap = {
      cold_food: "Customers are reporting food temperature problems across complaint signals.",
      delivery_delay: "Customers are reporting delivery delays and long waits.",
      wrong_order: "Customers are reporting missing or incorrect items.",
      rude_staff: "Customers are reporting rude or unprofessional staff interactions.",
    };

    topPattern = {
      title: titleMap[topTag] || "Complaint pattern detected",
      summary: summaryMap[topTag] || "A complaint pattern is emerging across recent signals.",
      count: counts[topTag] || 0,
      sourceMix: sourceMixParts.join(" · ") || "—",
      examples: examplesByType[topTag] || [],
    };
  }

  const reviewComplaintSignals =
    (sources.google || 0) + (sources.ubereats || 0) + (sources.grubhub || 0);

  return {
    lastUpdatedMs: Date.now(),
    windowDays: 30,
    totals: {
      all: voiceComplaints.length + reviewComplaintSignals,
      voice: voiceComplaints.length,
      reviews: reviewComplaintSignals,
    },
    counts,
    sources,
    byTypeSource,
    topTags,
    topPattern,
  };
}

/* --------------------------- Run Restaurant Reputation Refresh  --------------------------- */

async function runRestaurantReputationRefresh({
  restaurantCode,
  apiKeySerp,
  apiKeyOpenAI,
}) {
  const cfgSnap = await db.ref(`restaurants/${restaurantCode}/config/reputation`).get();
  const cfg = cfgSnap.val() || {};

  if (!cfg?.googlePlaceId) {
    throw new Error("googlePlaceId not configured");
  }

  const restaurantDisplayName = safeTrim(cfg.restaurantDisplayName || "");

  const restaurantTimeZone =
    safeTrim(cfg.timeZone || "") ||
    (await db.ref(`restaurants/${restaurantCode}/config/timeZone`).get()).val() ||
    "America/Toronto";

  const serpDataId = safeTrim(cfg.serpDataId || "");
  const placeId = safeTrim(cfg.googlePlaceId || "");
  const basePath = `restaurants/${restaurantCode}/reputation/serpapi`;

  const nowMs = Date.now();
  const cutoffMs = nowMs - 90 * 24 * 60 * 60 * 1000;

  const newestResp = await fetchSerpApiReviews({
    apiKey: apiKeySerp,
    dataId: serpDataId,
    placeId,
    hl: "en",
    maxPages: 25,
    sortBy: "newestFirst",
  });

  const highestResp = await fetchSerpApiReviews({
    apiKey: apiKeySerp,
    dataId: serpDataId,
    placeId,
    hl: "en",
    maxPages: 25,
    sortBy: "highestRating",
  });

  const lowestResp = await fetchSerpApiReviews({
    apiKey: apiKeySerp,
    dataId: serpDataId,
    placeId,
    hl: "en",
    maxPages: 25,
    sortBy: "lowestRating",
  });

  const reviews = [
    ...(Array.isArray(newestResp?.reviews) ? newestResp.reviews : []),
    ...(Array.isArray(highestResp?.reviews) ? highestResp.reviews : []),
    ...(Array.isArray(lowestResp?.reviews) ? lowestResp.reviews : []),
  ];

  const uniqueReviews = Object.values(
    reviews.reduce((acc, r) => {
      const key = r?.review_id || r?.reviewId || null;
      if (key) acc[key] = r;
      return acc;
    }, {})
  );

  const placeSignals = await fetchSerpApiPlaceSignals({
    apiKey: apiKeySerp,
    dataId: serpDataId,
    placeId,
    hl: "en",
  });

  console.log("placeSignals", JSON.stringify(placeSignals, null, 2));

  const updates = {};

  for (const r of uniqueReviews) {
    const iso = r?.iso_date || r?.iso_date_of_last_edit || "";
    const dateMs = toMsFromIso(iso);

    if (!dateMs || dateMs < cutoffMs) continue;

    const text =
      (r?.text || r?.snippet || r?.extracted_snippet?.original || "")
        .toString()
        .trim();

    if (!text) continue;

    const reviewId = sanitizeDbKey(
      r?.review_id || `serp_${r?.user?.name || "anon"}_${iso || Date.now()}`
    );

    updates[`${basePath}/reviews/${reviewId}`] = {
      reviewId,
      source: safeTrim(r?.source || "Google"),
      rating: typeof r?.rating === "number" ? r.rating : null,
      dateMs,
      isoDate: safeTrim(iso),
      authorName: safeTrim(r?.user?.name || ""),
      authorLink: safeTrim(r?.user?.link || ""),
      snippet: safeTrim(r?.snippet || ""),
      text,
      language: "en",
      likes: typeof r?.likes === "number" ? r.likes : 0,
      hasResponse: !!r?.response,
      responseText: safeTrim(
        r?.response?.extracted_snippet?.original ||
          r?.response?.snippet ||
          ""
      ),
      fetchedAtMs: nowMs,
    };
  }

  const storedReviews = Object.keys(updates).length;

  await db.ref(`${basePath}/reviews`).set(null);

  if (Object.keys(updates).length > 0) {
    await db.ref().update(updates);
  }

  const reviewsSnap = await db.ref(`${basePath}/reviews`).get();
  const reviewsObj = reviewsSnap.val() || {};
  const reviewsArr = Object.values(reviewsObj);

  // ✅ FIX: load Uber Eats BEFORE using it
  let uberEatsReviews = [];

  try {
    const uberSnap = await db
      .ref(`restaurants/${restaurantCode}/reputation/ubereats/reviewsNormalized`)
      .get();

    const uberObj = uberSnap.val() || {};
    uberEatsReviews = Object.values(uberObj);
  } catch (err) {
    console.error("Uber Eats RTDB read failed:", err.message || err);
  }



const { normalizeOpenTableReviews } = require("./lib/normalizeOpenTableReviews");
const { parseOpenTableUrl } = require("./lib/parseOpenTableUrl");

// TEMP (we will switch to config later)
const opentableUrl = safeTrim(cfg.opentableUrl || "");

let openTableAiSummary = null;
let openTableReviews = [];
let openTableRatingsSummary = null;

if (opentableUrl) {
  const { rid, openTableDomain } = parseOpenTableUrl(opentableUrl);

  if (!rid || !openTableDomain || !openTableDomain.includes("opentable")) {
    console.warn("Skipping OpenTable: invalid opentableUrl", {
      restaurantCode,
      opentableUrl,
      rid,
      openTableDomain,
    });
  } else {
    const page1 = await fetchSerpApiOpenTableReviews({
      rid,
      openTableDomain,
      apiKey: apiKeySerp,
      page: 1,
    });

    const page2 = await fetchSerpApiOpenTableReviews({
      rid,
      openTableDomain,
      apiKey: apiKeySerp,
      page: 2,
    });

    openTableAiSummary =
      page1?.meta?.summary?.ai_summary ||
      page2?.meta?.summary?.ai_summary ||
      null;

    const allOpenTableReviews = [
      ...(page1?.reviews || []),
      ...(page2?.reviews || []),
    ];

    openTableReviews = normalizeOpenTableReviews(allOpenTableReviews);
  }
}
  // ✅ FIX: now safe to merge
const phase2Reviews = [
  ...(reviewsArr || []),
  ...(uberEatsReviews || []),
  ...(openTableReviews || []),
];

  const voiceComplaints = await getRecentVoiceComplaintSignals(restaurantCode, { windowDays: 30 });

  const googleReviewItems = (reviews || []).map((r) => ({
    text: r?.text || r?.snippet || r?.reviewText || "",
  }));

  const uberEatsReviewItems = (uberEatsReviews || []).map((r) => ({
    text: r?.text || r?.originalText || "",
  }));

  const openTableReviewItems = (openTableReviews || []).map((r) => ({
    text: r?.text || "",
  }));

  const complaintTrends = buildRestaurantComplaintTrends({
  
  reviewItems: [
    ...googleReviewItems,
    ...uberEatsReviewItems,
    ...openTableReviewItems,
  ],
    callItems: (voiceComplaints || []).map((c) => ({
      transcript:
        c?.transcript ||
        c?.summary ||
        c?.text ||
        c?.complaintText ||
        "",
    })),
    messageItems: [],
  });

  await db.ref(`${basePath}/meta`).update({
    ok: true,
    restaurantCode,
    placeId,
    serpDataId,
    hl: "en",
    maxPages: 25,
    fetchedAtMs: nowMs,
    cutoffMs,
    cutoffIso: new Date(cutoffMs).toISOString(),
    storedReviews,
    voiceComplaintCount30d: voiceComplaints.length,
    uberEatsReviewCount: uberEatsReviews.length,
    openTableReviewCount: openTableReviews.length,
    openTableAiSummary,
    openTableRatingsSummary,
    googleTotalRatings: placeSignals?.userRatingsTotal || null,
    googleRating: placeSignals?.rating || null,
    note: "Restaurant reputation refresh (manual or scheduled)",
  });


const phase1Reviews = [
  ...(reviewsArr || []),
  ...(uberEatsReviews || []),
  ...(openTableReviews || []),
];

const phase1Report = await buildRestaurantReputationPhase1Report({
  restaurantCode,
  restaurantDisplayName,
  reviews: phase1Reviews,
  apiKey: apiKeyOpenAI,
});

  await db.ref(`restaurants/${restaurantCode}/insights/reputationPhase1`).set(phase1Report);

  const phase2Report = await buildRestaurantReputationPhase2Report({
    restaurantCode,
    restaurantDisplayName,
    reviews: phase2Reviews,
    apiKey: apiKeyOpenAI,
    restaurantTimeZone,
  });

  if (phase2Report && typeof phase2Report === "object") {
    phase2Report.complaintTrends = complaintTrends;
  }

  const nowKey = dayKeyFromMs(Date.now(), restaurantTimeZone);

  await db.ref(`restaurants/${restaurantCode}/insights/reputationPhase2/latest`).set(phase2Report);

  await db.ref(
    `restaurants/${restaurantCode}/insights/reputationPhase2/history/${sanitizeDbKey(nowKey)}`
  ).set({
    ...phase2Report,
    snapshotDayKey: nowKey,
  });

  // ------------------- NEW: Respond (Review Responses) -------------------
const allReviewSources = [
  ...(reviewsArr || []),
  ...(uberEatsReviews || []),
];

await buildReviewResponses({
  restaurantCode,
  restaurantDisplayName,
  reviews: allReviewSources,
  apiKey: apiKeyOpenAI,
  db,
});

  await db.ref(`restaurants/${restaurantCode}/reputation/complaintTrends/latest`).set({
    ...complaintTrends,
    snapshotDayKey: nowKey,
  });

  return {
    ok: true,
    restaurantCode,
    totalReviews: reviewsArr.length,
    storedReviews,
    risingThemes: phase2Report?.trend?.risingThemes?.length || 0,
    complaintTrendsSummary: {
      totalSignals: complaintTrends?.totals?.matchedItems || 0,
      voice: complaintTrends?.sources?.call || 0,
      reviews: complaintTrends?.sources?.review || 0,
      topTag: complaintTrends?.topTags?.[0]?.key || null,
      topTagCount: complaintTrends?.topTags?.[0]?.count || 0,
    },
  };
}

/*--------- GetREstaurantUberEasts config -----  */

async function getRestaurantsWithUberEatsConfig() {
  const snap = await admin.database().ref("restaurants").once("value");
  const restaurants = snap.val() || {};

  return Object.entries(restaurants)
    .map(([restaurantCode, restaurantData]) => {
      const reputationConfig = restaurantData?.config?.reputation || {};
      return {
        restaurantCode,
        googlePlaceId: reputationConfig.googlePlaceId || null,
        serpDataId: reputationConfig.serpDataId || null,
        restaurantDisplayName: reputationConfig.restaurantDisplayName || null,
        timeZone: reputationConfig.timeZone || null,
        uberEatsStoreUrl: reputationConfig.uberEatsStoreUrl || null,
      };
    })
    .filter((item) => !!item.uberEatsStoreUrl);
}

/* --------------------------- HTTPS: refreshRestaurantReputation --------------------------- */
/**
 * Single endpoint for dashboard refresh
 *
 * 1) Sync SERP reviews
 * 2) Build Phase 1
 * 3) Build Phase 2
 */
exports.refreshRestaurantReputation = onRequest(
  {
    region: "us-central1",
    secrets: [SERPAPI_API_KEY, OPENAI_API_KEY],
    timeoutSeconds: 300,
    memory: "1GiB",
  },
  async (req, res) => {
    setCors(res);
    if (req.method === "OPTIONS") return res.status(204).send("");

    try {
      const restaurantCodeRaw =
        (typeof req.query.restaurantCode === "string" && req.query.restaurantCode.trim()) ||
        (typeof req.body?.restaurantCode === "string" && req.body?.restaurantCode.trim()) ||
        "";

      const restaurantCode = safeTrim(restaurantCodeRaw).toLowerCase();

      if (!restaurantCode) {
        return res.status(400).json({ ok: false, error: "restaurantCode required" });
      }

      const apiKeySerp = SERPAPI_API_KEY.value();
      const apiKeyOpenAI = OPENAI_API_KEY.value();

      const result = await runRestaurantReputationRefresh({
        restaurantCode,
        apiKeySerp,
        apiKeyOpenAI,
      });

      return res.json(result);
    } catch (err) {
      console.error("refreshRestaurantReputation error:", err);
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  }
);

function emptyComplaintTrends() {
  return {
    totals: {
      matchedItems: 0,
      uniqueTypes: 0,
      uniquePatterns: 0,
    },
    counts: {},
    sources: {},
    byTypeSource: {},
    topTags: [],
    topPattern: [],
  };
}

function incrementMap(map, key, amount = 1) {
  if (!key) return;
  map[key] = (map[key] || 0) + amount;
}

function buildRestaurantComplaintTrends({
  reviewItems = [],
  callItems = [],
  messageItems = [],
}) {
  const trends = emptyComplaintTrends();

  const typeCounts = {};
  const patternCounts = {};
  const sourceCounts = {};
  const byTypeSource = {};

  function processItems(items, sourceName) {
    for (const item of items) {
      const text =
        item?.text ||
        item?.reviewText ||
        item?.content ||
        item?.transcript ||
        item?.message ||
        "";

      const matches = classifyRestaurantComplaintText(text, sourceName);
      if (!matches.length) continue;

      incrementMap(sourceCounts, sourceName, 1);

      for (const match of matches) {
        incrementMap(typeCounts, match.type, 1);
        incrementMap(patternCounts, match.pattern, 1);

        if (!byTypeSource[match.type]) byTypeSource[match.type] = {};
        incrementMap(byTypeSource[match.type], sourceName, 1);

        trends.totals.matchedItems += 1;
      }
    }
  }

  processItems(reviewItems, "review");
  processItems(callItems, "call");
  processItems(messageItems, "message");

  trends.counts = typeCounts;
  trends.sources = sourceCounts;
  trends.byTypeSource = byTypeSource;

  trends.totals.uniqueTypes = Object.keys(typeCounts).length;
  trends.totals.uniquePatterns = Object.keys(patternCounts).length;

  trends.topTags = Object.entries(typeCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([type, count]) => {
      const category = RESTAURANT_COMPLAINT_TAXONOMY.find((x) => x.type === type);
      return {
        key: type,
        label: category?.label || type,
        count,
      };
    });

  trends.topPattern = Object.entries(patternCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([patternKey, count]) => {
      let found = null;

      for (const category of RESTAURANT_COMPLAINT_TAXONOMY) {
        const pattern = category.patterns.find((p) => p.key === patternKey);
        if (pattern) {
          found = {
            type: category.type,
            typeLabel: category.label,
            pattern: pattern.key,
            label: pattern.label,
            count,
          };
          break;
        }
      }

      return (
        found || {
          type: "OTHER",
          typeLabel: "Other",
          pattern: patternKey,
          label: patternKey,
          count,
        }
      );
    });

  return trends;
}

/* --------------------------- Create Restaurant OnBoarding --------------------------- */

exports.createRestaurantOnboarding = onRequest(
  {
    region: "us-central1",
    secrets: [SERPAPI_API_KEY, OPENAI_API_KEY],
    timeoutSeconds: 300,
    memory: "1GiB",
  },
  async (req, res) => {
    setCors(res);
    if (req.method === "OPTIONS") return res.status(204).send("");

    try {
      const restaurantCode = safeTrim(req.body?.restaurantCode || "").toLowerCase();
      const restaurantName = safeTrim(req.body?.restaurantName || "");
      const assistantId = safeTrim(req.body?.assistantId || "");
      const timeZone = safeTrim(req.body?.timeZone || "");
      const googlePlaceId = safeTrim(req.body?.googlePlaceId || "");
      const userDocId = safeTrim(req.body?.userDocId || "");

      if (!restaurantCode) {
        return res.status(400).json({ ok: false, error: "restaurantCode required" });
      }

      if (!restaurantName) {
        return res.status(400).json({ ok: false, error: "restaurantName required" });
      }

      if (!assistantId) {
        return res.status(400).json({ ok: false, error: "assistantId required" });
      }

      if (!timeZone) {
        return res.status(400).json({ ok: false, error: "timeZone required" });
      }

      if (!googlePlaceId) {
        return res.status(400).json({ ok: false, error: "googlePlaceId required" });
      }

      if (!userDocId) {
        return res.status(400).json({ ok: false, error: "userDocId required" });
      }

      const firestore = admin.firestore();

await firestore.collection("users").doc(userDocId).set(
  {
    assistantId,
    restaurantCode,
    restaurantName,
    contactPhoneNumber: safeTrim(req.body?.contactPhoneNumber || ""),
    email: safeTrim(req.body?.email || ""),
    name: safeTrim(req.body?.name || ""),
    password: safeTrim(req.body?.password || ""),
    planName: safeTrim(req.body?.planName || ""),
    planMonthlyCalls: Number(req.body?.planMonthlyCalls || 0),
    planMonthlyFee: Number(req.body?.planMonthlyFee || 0),
    planOverageFee: Number(req.body?.planOverageFee || 0),
    planStartMonth: safeTrim(req.body?.planStartMonth || ""),
  },
  { merge: true }
);

      await db.ref(`restaurants/${restaurantCode}/config`).update({
        assistantId,
        timeZone,
      });

      const serpMapsResp = await axios.get("https://serpapi.com/search.json", {
        params: {
          engine: "google_maps",
          q: restaurantName,
          hl: "en",
          api_key: SERPAPI_API_KEY.value(),
        },
      });

      const resolvedSerpDataId =
        safeTrim(serpMapsResp?.data?.place_results?.data_id || "");

      if (!resolvedSerpDataId) {
        return res.status(400).json({
          ok: false,
          error: "Unable to resolve serpDataId from SerpAPI",
          restaurantName,
        });
      }

      await db.ref(`restaurants/${restaurantCode}/config/reputation`).update({
        googlePlaceId,
        serpDataId: resolvedSerpDataId,
        restaurantDisplayName: restaurantName,
        active: true,
      });

      const apiKeyOpenAI = OPENAI_API_KEY.value();

      const refreshResult = { skipped: true, reason: "post-onboarding refresh deferred" };

      return res.json({
        ok: true,
        step: "onboarding_completed",
        restaurantCode,
        restaurantName,
        assistantId,
        timeZone,
        googlePlaceId,
        serpDataId: resolvedSerpDataId,
        userDocId,
        refreshResult,
      });
      
    } catch (err) {
      console.error("createRestaurantOnboarding error:", err);
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  }
);
/* --------------------------- Test UberEatsApifySearch --------------------------- */

exports.testUberEatsApifyFetch = onRequest(async (req, res) => {
  try {
    const restaurantCode = String(
      req.query.restaurantCode || req.body?.restaurantCode || ""
    ).trim();

    if (!restaurantCode) {
      return res.status(400).json({
        ok: false,
        error: "Missing restaurantCode",
      });
    }

    const source = await getUberEatsSource(restaurantCode);

    if (!source.ok) {
      return res.status(400).json({
        ok: false,
        error: source.reason || "Unable to load Uber Eats source",
      });
    }

    if (!source.enabled) {
      return res.status(200).json({
        ok: true,
        restaurantCode,
        enabled: false,
        reason: source.reason || "Uber Eats source disabled",
      });
    }

    const normalized = await getNormalizedUberEatsReviews(restaurantCode, {
      maxReviews: 20,
    });

    return res.status(200).json({
      ok: true,
      restaurantCode,
      enabled: true,
      source: "uber_eats",
      normalizedCount: normalized.length,
      sample: normalized.slice(0, 3),
    });
  } catch (err) {
    console.error("testUberEatsApifyFetch error:", err);
    return res.status(500).json({
      ok: false,
      error: err.message || "Unknown error",
    });
  }
});

exports.syncUberEatsReviews = onSchedule(
  {
    schedule: "every day 04:00",
    timeZone: "America/Toronto",
    timeoutSeconds: 540,
    memory: "1GiB",
  },
  async () => {
    console.log("syncUberEatsReviews started");

    const restaurants = await getRestaurantsWithUberEatsConfig();

    console.log("syncUberEatsReviews found restaurants", {
      count: restaurants.length,
      restaurantCodes: restaurants.map((r) => r.restaurantCode),
    });

    for (const restaurant of restaurants) {
      const restaurantCode = safeTrim(restaurant?.restaurantCode || "").toLowerCase();
      if (!restaurantCode) continue;

try {
  const source = await getUberEatsSource(restaurantCode);

  console.log("syncUberEatsReviews source check", {
    restaurantCode,
    ok: !!source?.ok,
    enabled: !!source?.enabled,
    reason: source?.reason || "",
  });

  if (!source?.ok || !source?.enabled) {
    continue;
  }

  const runInfo = await fetchUberEatsReviews({
    restaurantCode,
    storeUrl: source.storeUrl,
  });

  console.log("syncUberEatsReviews Apify started", {
    restaurantCode,
    runId: runInfo?.runId || "",
    datasetId: runInfo?.datasetId || "",
    status: runInfo?.status || "",
  });
} catch (err) {

        console.error("syncUberEatsReviews source check failed", {
          restaurantCode,
          error: String(err?.message || err),
        });
      }
    }

    return null;
  }
);

async function runUberEatsSyncJob() {
  console.log("syncUberEatsReviews started");

  const restaurants = await getRestaurantsWithUberEatsConfig();

  console.log("syncUberEatsReviews found restaurants", {
    count: restaurants.length,
    restaurantCodes: restaurants.map((r) => r.restaurantCode),
  });

  for (const restaurant of restaurants) {
    const restaurantCode = safeTrim(restaurant?.restaurantCode || "").toLowerCase();
    if (!restaurantCode) continue;

    try {
      const source = await getUberEatsSource(restaurantCode);

      console.log("syncUberEatsReviews source check", {
        restaurantCode,
        ok: !!source?.ok,
        enabled: !!source?.enabled,
        reason: source?.reason || "",
      });

      if (!source?.ok || !source?.enabled) {
        continue;
      }

      const runInfo = await fetchUberEatsReviews({
        restaurantCode,
        storeUrl: source.storeUrl,
      });

      console.log("syncUberEatsReviews Apify started", {
        restaurantCode,
        runId: runInfo?.runId || "",
        datasetId: runInfo?.datasetId || "",
        status: runInfo?.status || "",
      });

      const nowMs = Date.now();

      await db.ref(`restaurants/${restaurantCode}/reputation/ubereats/pendingRun`).set({
        ok: true,
        restaurantCode,
        runId: runInfo?.runId || "",
        datasetId: runInfo?.datasetId || "",
        status: runInfo?.status || "",
        startedAtMs: nowMs,
        startedAtIso: new Date(nowMs).toISOString(),
        ingested: false,
      });

      console.log("syncUberEatsReviews pending run stored", {
        restaurantCode,
        runId: runInfo?.runId || "",
        datasetId: runInfo?.datasetId || "",
      });
    } catch (err) {
      console.error("syncUberEatsReviews failed", {
        restaurantCode,
        error: String(err?.message || err),
      });
    }
  }

  return null;
}

/* ----------run uber eats Sync Now Job ---------   */

exports.runUberEatsSyncNow = onRequest(
  {
    region: "us-central1",
    timeoutSeconds: 540,
    memory: "1GiB",
  },
  async (req, res) => {
    setCors(res);
    if (req.method === "OPTIONS") return res.status(204).send("");

    try {
      console.log("runUberEatsSyncNow started");

      const restaurants = await getRestaurantsWithUberEatsConfig();

      console.log("runUberEatsSyncNow found restaurants", {
        count: restaurants.length,
        restaurantCodes: restaurants.map((r) => r.restaurantCode),
      });

      for (const restaurant of restaurants) {
        const restaurantCode = safeTrim(restaurant?.restaurantCode || "").toLowerCase();
        if (!restaurantCode) continue;

        try {
          const source = await getUberEatsSource(restaurantCode);

          console.log("runUberEatsSyncNow source check", {
            restaurantCode,
            ok: !!source?.ok,
            enabled: !!source?.enabled,
            reason: source?.reason || "",
          });

          if (!source?.ok || !source?.enabled) {
            continue;
          }

          const runInfo = await fetchUberEatsReviews({
            restaurantCode,
            storeUrl: source.storeUrl,
          });

          console.log("runUberEatsSyncNow Apify started", {
            restaurantCode,
            runId: runInfo?.runId || "",
            datasetId: runInfo?.datasetId || "",
            status: runInfo?.status || "",
          });

          const nowMs = Date.now();

          await db.ref(`restaurants/${restaurantCode}/reputation/ubereats/pendingRun`).set({
            ok: true,
            restaurantCode,
            runId: runInfo?.runId || "",
            datasetId: runInfo?.datasetId || "",
            status: runInfo?.status || "",
            startedAtMs: nowMs,
            startedAtIso: new Date(nowMs).toISOString(),
            ingested: false,
          });

          console.log("runUberEatsSyncNow pending run stored", {
            restaurantCode,
            runId: runInfo?.runId || "",
            datasetId: runInfo?.datasetId || "",
          });
        } catch (err) {
          console.error("runUberEatsSyncNow failed", {
            restaurantCode,
            error: String(err?.message || err),
          });
        }
      }

      return res.json({ ok: true });
    } catch (err) {
      console.error("runUberEatsSyncNow error:", err);
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  }
);

/* -------------------- Ingest Uber Eats Reviews On Scehdule ------------------*/

exports.ingestUberEatsReviews = onSchedule(
  {
    schedule: "every day 04:20",
    timeZone: "America/Toronto",
    timeoutSeconds: 540,
    memory: "1GiB",
  },
  async () => {
    console.log("ingestUberEatsReviews started");

    const restaurants = await getRestaurantsWithUberEatsConfig();

    console.log("ingestUberEatsReviews found restaurants", {
      count: restaurants.length,
      restaurantCodes: restaurants.map((r) => r.restaurantCode),
    });

    for (const restaurant of restaurants) {
      const restaurantCode = safeTrim(restaurant?.restaurantCode || "").toLowerCase();
      if (!restaurantCode) continue;

      try {
        const pendingSnap = await db
          .ref(`restaurants/${restaurantCode}/reputation/ubereats/pendingRun`)
          .get();

        const pending = pendingSnap.val() || {};
        const runId = safeTrim(pending?.runId || "");
        const datasetIdFromPending = safeTrim(pending?.datasetId || "");
        const alreadyIngested = pending?.ingested === true;

        if (!runId || alreadyIngested) {
          continue;
        }

        const finalRun = await waitForApifyRun(runId, {
          pollMs: 5000,
          timeoutMs: 60000,
        });

        const finalStatus = safeTrim(finalRun?.status || pending?.status || "");
        const datasetId = safeTrim(finalRun?.defaultDatasetId || datasetIdFromPending || "");

        console.log("ingestUberEatsReviews run check", {
          restaurantCode,
          runId,
          datasetId,
          status: finalStatus,
        });

        if (!datasetId) {
          await db.ref(`restaurants/${restaurantCode}/reputation/ubereats/pendingRun`).update({
            status: finalStatus || "UNKNOWN",
            lastCheckedAtMs: Date.now(),
            ingested: false,
            error: "Missing datasetId after run check",
          });
          continue;
        }

const items = await getApifyDatasetItems(datasetId);
const safeItems = Array.isArray(items) ? items : [];
const nowMs = Date.now();

await db.ref(`restaurants/${restaurantCode}/reputation/ubereats/reviews`).set(null);
await db.ref(`restaurants/${restaurantCode}/reputation/ubereats/reviewsNormalized`).set(null);

const updates = {};

safeItems.forEach((item, index) => {
  const rawKey = sanitizeDbKey(
    item?.reviewId || item?.id || `${restaurantCode}_ubereats_${index}_${nowMs}`
  );

  updates[`restaurants/${restaurantCode}/reputation/ubereats/reviews/${rawKey}`] = {
    ...item,
    source: "ubereats",
    fetchedAtMs: nowMs,
  };

  const text =
    safeTrim(item?.text) ||
    safeTrim(item?.reviewText) ||
    safeTrim(item?.content) ||
    "";

  const authorName =
    safeTrim(item?.authorName) ||
    safeTrim(item?.author) ||
    safeTrim(item?.userName) ||
    "";

  const ratingRaw = item?.rating;
  const rating =
    typeof ratingRaw === "number"
      ? ratingRaw
      : Number.isFinite(Number(ratingRaw))
      ? Number(ratingRaw)
      : null;

  const isoCandidate =
    safeTrim(item?.isoDate) ||
    safeTrim(item?.date) ||
    safeTrim(item?.publishedAt) ||
    safeTrim(item?.createdAt) ||
    "";

  const parsedMs = toMsFromIso(isoCandidate);
  const dateMs = parsedMs || nowMs;
  const isoDate = parsedMs ? new Date(parsedMs).toISOString() : "";

  const normalizedKey = sanitizeDbKey(
    `ubereats_${item?.reviewId || item?.id || index}_${dateMs}`
  );

  updates[`restaurants/${restaurantCode}/reputation/ubereats/reviewsNormalized/${normalizedKey}`] = {
    reviewId: normalizedKey,
    source: "ubereats",
    authorName,
    rating,
    text,
    dateMs,
    isoDate,
    fetchedAtMs: nowMs,
    rawReviewKey: rawKey,
  };
});

updates[`restaurants/${restaurantCode}/reputation/ubereats/meta`] = {
  ok: true,
  restaurantCode,
  runId,
  datasetId,
  itemCount: safeItems.length,
  normalizedItemCount: safeItems.length,
  fetchedAtMs: nowMs,
  fetchedAtIso: new Date(nowMs).toISOString(),
  note: "Raw and normalized Uber Eats dataset items stored from Apify ingestion job",
};

        updates[`restaurants/${restaurantCode}/reputation/ubereats/pendingRun`] = {
          ...(pending || {}),
          runId,
          datasetId,
          status: finalStatus || "SUCCEEDED",
          lastCheckedAtMs: nowMs,
          ingested: true,
          ingestedAtMs: nowMs,
          ingestedAtIso: new Date(nowMs).toISOString(),
          itemCount: safeItems.length,
        };

        await db.ref().update(updates);

        console.log("ingestUberEatsReviews write complete", {
          restaurantCode,
          datasetId,
          itemCount: safeItems.length,
        });
      } catch (err) {
        console.error("ingestUberEatsReviews failed", {
          restaurantCode,
          error: String(err?.message || err),
        });
      }
    }

    return null;
  }
);

/* -------------------- Ingest Uber Eats Reviews Now ------------------*/

exports.runUberEatsIngestNow = onRequest(
  {
    region: "us-central1",
    timeoutSeconds: 540,
    memory: "1GiB",
  },
  async (req, res) => {
    setCors(res);
    if (req.method === "OPTIONS") return res.status(204).send("");

    try {
      console.log("runUberEatsIngestNow started");
      console.log("runUberEatsIngestNow before getRestaurantsWithUberEatsConfig");

      const restaurants = await getRestaurantsWithUberEatsConfig();

      console.log("runUberEatsIngestNow after getRestaurantsWithUberEatsConfig");
      console.log("runUberEatsIngestNow found restaurants", {
        count: restaurants.length,
        restaurantCodes: restaurants.map((r) => r.restaurantCode),
      });

      for (const restaurant of restaurants) {
        const restaurantCode = safeTrim(restaurant?.restaurantCode || "").toLowerCase();
        if (!restaurantCode) continue;

        console.log("runUberEatsIngestNow entered restaurant loop", {
          restaurantCode,
        });

        try {
          console.log("runUberEatsIngestNow reading pendingRun", {
            restaurantCode,
          });

          const pendingSnap = await db
            .ref(`restaurants/${restaurantCode}/reputation/ubereats/pendingRun`)
            .get();

          const pending = pendingSnap.val() || {};
          const runId = safeTrim(pending?.runId || "");
          const datasetIdFromPending = safeTrim(pending?.datasetId || "");
          const alreadyIngested = pending?.ingested === true;

          console.log("runUberEatsIngestNow pendingRun loaded", {
            restaurantCode,
            runId,
            datasetId: datasetIdFromPending,
            alreadyIngested,
          });

          if (!runId || alreadyIngested) {
            console.log("runUberEatsIngestNow skipping restaurant", {
              restaurantCode,
              reason: !runId ? "missing_runId" : "already_ingested",
            });
            continue;
          }

          const finalRun = await waitForApifyRun(runId, {
            pollMs: 5000,
            timeoutMs: 60000,
          });

          const finalStatus = safeTrim(finalRun?.status || pending?.status || "");
          const datasetId = safeTrim(finalRun?.defaultDatasetId || datasetIdFromPending || "");

          console.log("runUberEatsIngestNow run check", {
            restaurantCode,
            runId,
            datasetId,
            status: finalStatus,
          });

          if (!datasetId) {
            await db.ref(`restaurants/${restaurantCode}/reputation/ubereats/pendingRun`).update({
              status: finalStatus || "UNKNOWN",
              lastCheckedAtMs: Date.now(),
              ingested: false,
              error: "Missing datasetId after run check",
            });
            continue;
          }

          const items = await getApifyDatasetItems(datasetId);
          const safeItems = Array.isArray(items) ? items : [];
          const nowMs = Date.now();

          await db.ref(`restaurants/${restaurantCode}/reputation/ubereats/reviews`).set(null);
          await db.ref(`restaurants/${restaurantCode}/reputation/ubereats/reviewsNormalized`).set(null);

          const updates = {};

          safeItems.forEach((item, index) => {
          const rawKey = sanitizeDbKey(
          item?.reviewId || item?.id || `${restaurantCode}_ubereats_${index}_${nowMs}`
        );

  updates[`restaurants/${restaurantCode}/reputation/ubereats/reviews/${rawKey}`] = {
    ...item,
    source: "ubereats",
    fetchedAtMs: nowMs,
  };

  const text =
    safeTrim(item?.text) ||
    safeTrim(item?.reviewText) ||
    safeTrim(item?.content) ||
    "";

  const authorName =
    safeTrim(item?.authorName) ||
    safeTrim(item?.author) ||
    safeTrim(item?.userName) ||
    "";

  const ratingRaw = item?.rating;
  const rating =
    typeof ratingRaw === "number"
      ? ratingRaw
      : Number.isFinite(Number(ratingRaw))
      ? Number(ratingRaw)
      : null;

  const isoCandidate =
    safeTrim(item?.isoDate) ||
    safeTrim(item?.date) ||
    safeTrim(item?.publishedAt) ||
    safeTrim(item?.createdAt) ||
    "";

  const parsedMs = toMsFromIso(isoCandidate);
  const dateMs = parsedMs || nowMs;
  const isoDate = parsedMs ? new Date(parsedMs).toISOString() : "";

  const normalizedKey = sanitizeDbKey(
    `ubereats_${item?.reviewId || item?.id || index}_${dateMs}`
  );

          updates[`restaurants/${restaurantCode}/reputation/ubereats/reviewsNormalized/${normalizedKey}`] = {
            reviewId: normalizedKey,
            source: "ubereats",
            authorName,
            rating,
            text,
            dateMs,
            isoDate,
            fetchedAtMs: nowMs,
            rawReviewKey: rawKey,
          };
});

          updates[`restaurants/${restaurantCode}/reputation/ubereats/meta`] = {
            ok: true,
            restaurantCode,
            runId,
            datasetId,
            itemCount: safeItems.length,
            normalizedItemCount: safeItems.length,
            fetchedAtMs: nowMs,
            fetchedAtIso: new Date(nowMs).toISOString(),
            note: "Raw and normalized Uber Eats dataset items stored from Apify ingestion job",
          };

          updates[`restaurants/${restaurantCode}/reputation/ubereats/pendingRun`] = {
            ...(pending || {}),
            runId,
            datasetId,
            status: finalStatus || "SUCCEEDED",
            lastCheckedAtMs: nowMs,
            ingested: true,
            ingestedAtMs: nowMs,
            ingestedAtIso: new Date(nowMs).toISOString(),
            itemCount: safeItems.length,
          };

          await db.ref().update(updates);

          console.log("runUberEatsIngestNow write complete", {
            restaurantCode,
            datasetId,
            itemCount: safeItems.length,
          });
        } catch (err) {
          console.error("runUberEatsIngestNow failed", {
            restaurantCode,
            error: String(err?.message || err),
          });
        }
      }

      return res.json({ ok: true });
    } catch (err) {
      console.error("runUberEatsIngestNow error:", err);
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  }
);

/* -------------------- Deliverect Web Hook ------------------*/

exports.deliverectReportingWebhook = onRequest(async (req, res) => {
  try {
    console.log("Deliverect webhook received");
    console.log("Method:", req.method);
    console.log("Headers:", req.headers);
    console.log("Body:", req.body);

    const payload = req.body || {};
    const receivedAt = Date.now();

    const storeId =
      payload.storeId ||
      payload.locationId ||
      payload.store?.id ||
      payload.location?.id ||
      "unknown_store";

    const mappingSnap = await admin
      .database()
      .ref(`storeMappings/${storeId}`)
      .once("value");

    const restaurantCode = mappingSnap.val() || "unknown_restaurant";

    const record = {
      receivedAt,
      storeId,
      restaurantCode,
      headers: req.headers || {},
      body: payload,
    };

    await admin
      .database()
      .ref(`restaurants/${restaurantCode}/deliverectRawOrders`)
      .push(record);

    return res.status(200).json({
      ok: true,
      message: "Webhook received and saved by restaurant",
      storeId,
      restaurantCode,
    });
  } catch (error) {
    console.error("deliverectReportingWebhook error:", error);
    return res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

/* -------------------- test open table fetch  ------- */

exports.testOpenTableFetch = onRequest(
  { secrets: [SERPAPI_API_KEY] },
  async (req, res) => {
    try {
      const restaurantCode = req.query.restaurantCode || "calwch";

      const { normalizeOpenTableReviews } = require("./lib/normalizeOpenTableReviews");
      const { parseOpenTableUrl } = require("./lib/parseOpenTableUrl");

      const opentableUrl =
        req.query.opentableUrl ||
        "https://www.opentable.ca/r/est-restaurant-toronto";

      const { rid, openTableDomain } = parseOpenTableUrl(opentableUrl);

      if (!rid || !openTableDomain || !openTableDomain.includes("opentable")) {
        return res.status(400).json({
          ok: false,
          error: "Invalid opentableUrl",
          opentableUrl,
          rid,
          openTableDomain,
        });
      }

      const page1 = await fetchSerpApiOpenTableReviews({
        rid,
        openTableDomain,
        apiKey: SERPAPI_API_KEY.value(),
        page: 1,
      });

      const page2 = await fetchSerpApiOpenTableReviews({
        rid,
        openTableDomain,
        apiKey: SERPAPI_API_KEY.value(),
        page: 2,
      });

      const allOpenTableReviews = [
        ...(page1?.reviews || []),
        ...(page2?.reviews || []),
      ];

      const normalized = normalizeOpenTableReviews(allOpenTableReviews);

      return res.json({
        ok: true,
        restaurantCode,
        opentableUrl,

        rid,
        openTableDomain,

        count: Array.isArray(allOpenTableReviews)
          ? allOpenTableReviews.length
          : 0,
        sample: Array.isArray(allOpenTableReviews)
          ? allOpenTableReviews.slice(0, 3)
          : [],

        normalizedCount: Array.isArray(normalized) ? normalized.length : 0,
        normalizedSample: Array.isArray(normalized)
          ? normalized.slice(0, 3)
          : [],

        meta: {
          page1: page1?.meta || null,
          page2: page2?.meta || null,
        },

        rawKeys: page1?.raw ? Object.keys(page1.raw) : [],
        rawSearchInformation: page1?.raw?.search_information || null,
        rawReviewsSummary: page1?.raw?.reviews_summary || null,
        rawPagination:
          page1?.raw?.pagination || page1?.raw?.serpapi_pagination || null,

        error: page1?.error || page2?.error || null,
      });
    } catch (err) {
      console.error("testOpenTableFetch error:", err);
      return res.status(500).json({
        ok: false,
        error: err?.message || "Unknown error",
      });
    }
  }
);
/* --------------------- HeySue Gateway API --------------------- */

exports.registerHeySueGateway = onRequest(
  {
    region: "us-central1",
    cors: true,
  },
  async (req, res) => {
    try {
      if (req.method !== "POST") {
        return res.status(405).json({
          success: false,
          error: "Method not allowed.",
        });
      }

      const gatewayID = String(req.body?.gatewayID || "").trim();
      const deviceSecret = String(req.body?.deviceSecret || "").trim();
      const hostname = String(req.body?.hostname || "").trim();
      const softwareVersion = String(
        req.body?.softwareVersion || "1.0.0"
      ).trim();

      if (!gatewayID || !deviceSecret) {
        return res.status(400).json({
          success: false,
          error: "gatewayID and deviceSecret are required.",
        });
      }

      const gatewayRef = db.ref(`gateways/${gatewayID}`);
      const gatewaySnapshot = await gatewayRef.once("value");

      if (!gatewaySnapshot.exists()) {
        return res.status(404).json({
          success: false,
          error: "Gateway record not found.",
        });
      }

      const gateway = gatewaySnapshot.val() || {};

      const suppliedFingerprint = crypto
        .createHash("sha256")
        .update(deviceSecret, "utf8")
        .digest("hex");

      const storedFingerprint = String(
        gateway.secretFingerprint || ""
      ).trim();

      const suppliedBuffer = Buffer.from(
        suppliedFingerprint,
        "utf8"
      );

      const storedBuffer = Buffer.from(
        storedFingerprint,
        "utf8"
      );

      const fingerprintMatches =
        suppliedBuffer.length === storedBuffer.length &&
        crypto.timingSafeEqual(
          suppliedBuffer,
          storedBuffer
        );

      if (!fingerprintMatches) {
        return res.status(401).json({
          success: false,
          error: "Gateway authentication failed.",
        });
      }

      if (gateway.assigned !== true || !gateway.locationID) {
        return res.status(409).json({
          success: false,
          error: "Gateway is not assigned to a restaurant.",
        });
      }

      const now = new Date().toISOString();

      await gatewayRef.update({
        activated: true,
        online: true,
        status: "online",
        hostname,
        softwareVersion,
        lastHeartbeat: now,
        activatedAt: gateway.activatedAt || now,
      });

      return res.status(200).json({
        success: true,
        gatewayID,
        locationID: gateway.locationID,
        activated: true,
        status: "online",
      });
    } catch (error) {
      console.error(
        "registerHeySueGateway failed:",
        error
      );

      return res.status(500).json({
        success: false,
        error: "Gateway registration failed.",
      });
    }
  }
);

exports.reportHeySueGatewayPrinter = onRequest(
  {
    region: "us-central1",
    cors: true,
  },
  async (req, res) => {
    try {
      if (req.method !== "POST") {
        return res.status(405).json({
          success: false,
          error: "Method not allowed.",
        });
      }

      const gatewayID = String(
        req.body?.gatewayID || ""
      ).trim();

      const deviceSecret = String(
        req.body?.deviceSecret || ""
      ).trim();

      const printerIp = String(
        req.body?.printerIp || ""
      ).trim();

      const printerMac = String(
        req.body?.printerMac || ""
      ).trim();

      const printerManufacturer = String(
        req.body?.printerManufacturer || ""
      ).trim();

      const printerPort = Number(
        req.body?.printerPort || 9100
      );

      if (!gatewayID || !deviceSecret || !printerIp) {
        return res.status(400).json({
          success: false,
          error:
            "gatewayID, deviceSecret, and printerIp are required.",
        });
      }

      const gatewayRef = db.ref(`gateways/${gatewayID}`);
      const gatewaySnapshot = await gatewayRef.once("value");

      if (!gatewaySnapshot.exists()) {
        return res.status(404).json({
          success: false,
          error: "Gateway record not found.",
        });
      }

      const gateway = gatewaySnapshot.val() || {};

      const suppliedFingerprint = crypto
        .createHash("sha256")
        .update(deviceSecret, "utf8")
        .digest("hex");

      const storedFingerprint = String(
        gateway.secretFingerprint || ""
      ).trim();

      const suppliedBuffer = Buffer.from(
        suppliedFingerprint,
        "utf8"
      );

      const storedBuffer = Buffer.from(
        storedFingerprint,
        "utf8"
      );

      const fingerprintMatches =
        suppliedBuffer.length === storedBuffer.length &&
        crypto.timingSafeEqual(
          suppliedBuffer,
          storedBuffer
        );

      if (!fingerprintMatches) {
        return res.status(401).json({
          success: false,
          error: "Gateway authentication failed.",
        });
      }

      if (gateway.assigned !== true || !gateway.locationID) {
        return res.status(409).json({
          success: false,
          error: "Gateway is not assigned to a restaurant.",
        });
      }

      const now = new Date().toISOString();

      await gatewayRef.update({
        online: true,
        status: "online",
        lastHeartbeat: now,
        "printer/status": "ready",
        "printer/ipAddress": printerIp,
        "printer/port": printerPort,
        "printer/macAddress": printerMac,
        "printer/manufacturer": printerManufacturer,
        "printer/model": printerManufacturer,
        "printer/discoveredAt": now,
        "commands/discoverPrinter/requested": false,
        "commands/discoverPrinter/status": "completed",
        "commands/discoverPrinter/completedAt": now,
      });

      return res.status(200).json({
        success: true,
        gatewayID,
        locationID: gateway.locationID,
        printer: {
          status: "ready",
          ipAddress: printerIp,
          port: printerPort,
          macAddress: printerMac,
          manufacturer: printerManufacturer,
        },
      });
    } catch (error) {
      console.error(
        "reportHeySueGatewayPrinter failed:",
        error
      );

      return res.status(500).json({
        success: false,
        error: "Printer reporting failed.",
      });
    }
  }
);
