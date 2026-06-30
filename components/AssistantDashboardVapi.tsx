"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  collection,
  getDocs,
  getFirestore,
  limit,
  orderBy,
  query,
  Timestamp,
  where,
} from "firebase/firestore";
import { get, getDatabase, ref as dbRef } from "firebase/database";
import { app as firebaseApp } from "@/lib/firebase";
import dynamic from "next/dynamic";
import { useAuth } from "@/components/AuthProvider";

// Recharts (client-only)
const ResponsiveContainer = dynamic(
  async () => (await import("recharts")).ResponsiveContainer,
  { ssr: false }
);
const LineChart = dynamic(async () => (await import("recharts")).LineChart, {
  ssr: false,
});
const Line = dynamic(async () => (await import("recharts")).Line, {
  ssr: false,
});
const XAxis = dynamic(async () => (await import("recharts")).XAxis, {
  ssr: false,
});
const YAxis = dynamic(async () => (await import("recharts")).YAxis, {
  ssr: false,
});
const Tooltip = dynamic(async () => (await import("recharts")).Tooltip, {
  ssr: false,
});
const CartesianGrid = dynamic(
  async () => (await import("recharts")).CartesianGrid,
  { ssr: false }
);

type CallRow = {
  id: string;
  assistantId: string;
  startTime?: Timestamp | null;
  endTime?: Timestamp | null;
  durationSeconds?: number | null;
  status?: string | null;
  from?: string | null;
  to?: string | null;
  recordingUrl?: string | null;
  transcript?: string | null;
};

type ReviewResponseItem = {
  reviewId: string;
  source?: string | null;
  rating?: number | null;
  text?: string | null;
  authorName?: string | null;
  date?: string | null;
  issueTags?: string[];
  draftResponse?: string | null;
  createdAtMs?: number | null;
};

type ReviewResponsesPayload = {
  restaurantCode?: string;
  restaurantDisplayName?: string;
  generatedAtMs?: number;
  totalNegativeReviews?: number;
  items?: ReviewResponseItem[];
};

type ViewMode =
  | "log"
  | "hourly"
  | "billing"
  | "invoice"
  | "restaurantPhase1"
  | "restaurantPhase2"
  | "respond";

// ----------------- Local-time date helpers -----------------
function startOfDay(d = new Date()) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}
function endOfDay(d = new Date()) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
}
function startOfMonth(d = new Date()) {
  return new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0);
}
function endOfMonth(d = new Date()) {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
}
function addMonths(d: Date, n: number) {
  const dt = new Date(d);
  dt.setMonth(d.getMonth() + n);
  return dt;
}
function startOfYear(d = new Date()) {
  return new Date(d.getFullYear(), 0, 1, 0, 0, 0, 0);
}
function endOfYear(d = new Date()) {
  return new Date(d.getFullYear(), 11, 31, 23, 59, 59, 999);
}

const PRESETS = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "this_month", label: "This Month" },
  { key: "last_month", label: "Last Month" },
  { key: "last_3_months", label: "Last 3 Months" },
  { key: "this_year", label: "This Year" },
  { key: "custom", label: "Custom Range" },
] as const;

type PresetKey = (typeof PRESETS)[number]["key"];

function resolveRange(
  preset: PresetKey,
  custom?: { start?: Date; end?: Date }
) {
  const now = new Date();
  switch (preset) {
    case "today":
      return { start: startOfDay(now), end: endOfDay(now) };
    case "yesterday": {
      const y = new Date(now);
      y.setDate(now.getDate() - 1);
      return { start: startOfDay(y), end: endOfDay(y) };
    }
    case "this_month":
      return { start: startOfMonth(now), end: endOfMonth(now) };
    case "last_month": {
      const prev = addMonths(now, -1);
      return { start: startOfMonth(prev), end: endOfMonth(prev) };
    }
    case "last_3_months":
      return { start: startOfMonth(addMonths(now, -2)), end: endOfMonth(now) };
    case "this_year":
      return { start: startOfYear(now), end: endOfYear(now) };
    case "custom":
    default:
      return {
        start: custom?.start ?? startOfMonth(now),
        end: custom?.end ?? endOfDay(now),
      };
  }
}

// Generate an array of month starts from A → B inclusive
function monthRangeInclusive(from: Date, to: Date) {
  const out: Date[] = [];
  let cur = startOfMonth(from);
  const end = startOfMonth(to);
  while (cur <= end) {
    out.push(new Date(cur));
    cur = addMonths(cur, 1);
  }
  return out;
}

// ----------------- Format helpers -----------------
function nf(n: number, opts?: Intl.NumberFormatOptions) {
  return new Intl.NumberFormat(undefined, opts).format(n);
}
function usd(n: number) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(n);
}
function minutesFromSeconds(s?: number | null) {
  return (s ?? 0) / 60;
}
function tsToDate(ts?: Timestamp | null): Date | null {
  if (!ts) return null;
  try {
    return ts.toDate();
  } catch {
    return null;
  }
}
function fmtDate(ts?: Timestamp | null) {
  const d = tsToDate(ts);
  return d ? d.toLocaleDateString() : "—";
}
function fmtTime(ts?: Timestamp | null) {
  const d = tsToDate(ts);
  return d
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : "—";
}
function fmtMonth(d: Date) {
  return d.toLocaleString(undefined, { month: "long", year: "numeric" });
}
function fmtDateFromString(value?: string | null) {
  if (!value) return "—";
  const d = new Date(value);
  if (isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString();
}

// Robust parser for legacy "Plan Start Month" strings
function parsePlanStartMonth(input?: string | null): Date | null {
  if (!input) return null;

  const cleaned = String(input)
    .replace(/[–—]/g, " ")
    .replace(/,/g, " ")
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const m1 = cleaned.match(/^([A-Za-z]+)\s+(\d{4})$/);
  if (m1) {
    const months = [
      "january",
      "february",
      "march",
      "april",
      "may",
      "june",
      "july",
      "august",
      "september",
      "october",
      "november",
      "december",
    ];
    const idx = months.indexOf(m1[1].toLowerCase());
    const year = parseInt(m1[2], 10);
    if (idx >= 0 && year >= 1970 && year <= 9999) {
      return new Date(year, idx, 1, 0, 0, 0, 0);
    }
  }

  let m = cleaned.match(/^(\d{4})[-/](\d{1,2})$/);
  if (m) {
    const year = parseInt(m[1], 10);
    const month = parseInt(m[2], 10) - 1;
    if (month >= 0 && month < 12) {
      return new Date(year, month, 1, 0, 0, 0, 0);
    }
  }

  m = cleaned.match(/^(\d{1,2})[-/](\d{4})$/);
  if (m) {
    const month = parseInt(m[1], 10) - 1;
    const year = parseInt(m[2], 10);
    if (month >= 0 && month < 12) {
      return new Date(year, month, 1, 0, 0, 0, 0);
    }
  }

  const fallback = new Date(cleaned);
  if (!isNaN(fallback.getTime())) {
    return new Date(
      fallback.getFullYear(),
      fallback.getMonth(),
      1,
      0,
      0,
      0,
      0
    );
  }

  return null;
}

function KpiCard({
  title,
  value,
  subtitle,
}: {
  title: string;
  value: string;
  subtitle?: string;
}) {
  return (
    <div className="rounded-2xl bg-white shadow-sm border border-slate-200 p-6">
      <div className="text-slate-500 text-sm font-medium tracking-wide uppercase">
        {title}
      </div>
      <div className="text-3xl md:text-4xl font-semibold text-slate-900 mt-2 break-words">
        {value}
      </div>
      {subtitle && (
        <div className="text-xs text-slate-400 mt-2">{subtitle}</div>
      )}
    </div>
  );
}

function ProgressBar({ pct }: { pct: number }) {
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div className="w-full h-3 rounded-full bg-gray-200 overflow-hidden">
      <div
        className={`h-full ${clamped >= 100 ? "bg-red-500" : "bg-green-500"}`}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}

// ============================================================

export default function AssistantDashboardVapi({
  assistantId,
  pageSize = 200,
}: {
  assistantId: string;
  pageSize?: number;
}) {
  // Period + custom range
  const [preset, setPreset] = useState<PresetKey>("this_month");
  const [customStart, setCustomStart] = useState<string>("");
  const [customEnd, setCustomEnd] = useState<string>("");

  // Data + UI state
  const [loading, setLoading] = useState<boolean>(false);
  const [rows, setRows] = useState<CallRow[]>([]);
  const displayedRows = useMemo(() => {
    return rows.slice(0, pageSize);
  }, [rows, pageSize]);
  const [error, setError] = useState<string | null>(null);

  // Drawer
  const [drawerId, setDrawerId] = useState<string | null>(null);

  // View switch (+ Billing + Invoice)
  const [view, setView] = useState<ViewMode>("billing");

  // Sync state
  const [syncing, setSyncing] = useState<boolean>(false);

  // Billing state
  const [planLoading, setPlanLoading] = useState<boolean>(true);
  const [planError, setPlanError] = useState<string | null>(null);
  const [planName, setPlanName] = useState<string>("-");
  const [planMonthlyCalls, setPlanMonthlyCalls] = useState<number>(0);
  const [planMonthlyFee, setPlanMonthlyFee] = useState<number>(0);
  const [planStartMonth, setPlanStartMonth] = useState<string | null>(null);
  const [planOverageFee, setPlanOverageFee] = useState<number>(0);
  const [callsThisMonth, setCallsThisMonth] = useState<number>(0);

  // INVOICE HISTORY
  type InvoiceRow = {
    month: string;
    planName: string;
    planMonthlyFee: number;
    planMonthlyCalls: number;
    actualCalls: number;
    callBalance: number;
    callOverageFee: number;
    calculatedOverage: number;
    totalInvoice: number;
  };

  const [invoiceLoading, setInvoiceLoading] = useState<boolean>(false);
  const [invoiceError, setInvoiceError] = useState<string | null>(null);
  const [invoiceRows, setInvoiceRows] = useState<InvoiceRow[]>([]);

  const authCtx = useAuth() as any;
  const [restaurantRepLoading, setRestaurantRepLoading] =
    useState<boolean>(false);
  const [restaurantRepError, setRestaurantRepError] = useState<string | null>(
    null
  );
  const [restaurantPhase1, setRestaurantPhase1] = useState<any>(null);
  const [restaurantPhase2, setRestaurantPhase2] = useState<any>(null);
  const [restaurantMeta, setRestaurantMeta] = useState<any>(null);
  const [restaurantComplaintTrends, setRestaurantComplaintTrends] =
    useState<any>(null);
  const [restaurantAlerts, setRestaurantAlerts] = useState<any[]>([]);
  const [reviewResponses, setReviewResponses] =
    useState<ReviewResponsesPayload | null>(null);
  const [copiedReviewId, setCopiedReviewId] = useState<string | null>(null);

  // Resolve the date range (local time)
  const { start, end } = useMemo(() => {
    const cs = customStart ? new Date(customStart) : undefined;
    const ce = customEnd ? new Date(customEnd) : undefined;
    return resolveRange(preset, { start: cs, end: ce });
  }, [preset, customStart, customEnd]);

  // -------- SYNC (server route) ----------
  async function syncNow() {
    setSyncing(true);
    setError(null);

    try {
      const params = new URLSearchParams({
        assistantId,
        start: start.toISOString(),
        end: end.toISOString(),
      });

      const res = await fetch(`/api/vapi/sync?${params}`, { method: "GET" });
      const json = await res.json().catch(() => null);

      if (!res.ok) {
        throw new Error(json?.error || "Sync failed.");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sync failed.");
    } finally {
      setSyncing(false);
      await loadData();
      await loadBillingUsage();

      const fresh = await loadBillingPlan();
      if (view === "invoice") {
        await loadInvoiceHistory(fresh ?? undefined);
      }
      if (
        view === "restaurantPhase1" ||
        view === "restaurantPhase2" ||
        view === "respond"
      ) {
        await loadRestaurantReputation();
      }
    }
  }

  // ✅ Auto-sync once on first mount (and whenever assistantId changes)
  const didAutoSyncRef = useRef(false);
  useEffect(() => {
    if (!assistantId) return;
    if (!didAutoSyncRef.current) {
      didAutoSyncRef.current = true;
      void syncNow();
    }
  }, [assistantId]);

  // -------- DATA (call logs) ----------
  async function loadData() {
    setLoading(true);
    setError(null);
    try {
      const db = getFirestore(firebaseApp);
      const col = collection(db, "callLogs");
      const qy = query(
        col,
        where("assistantId", "==", assistantId),
        orderBy("startTime", "desc"),
        where("startTime", ">=", Timestamp.fromDate(start)),
        where("startTime", "<=", Timestamp.fromDate(end))
      );
      const snap = await getDocs(qy);
      const arr: CallRow[] = snap.docs.map((d) => {
        const data = d.data() as Record<string, unknown>;
        return {
          id: d.id,
          assistantId: String(data.assistantId ?? assistantId),
          startTime: (data.startTime as Timestamp) ?? null,
          endTime: (data.endTime as Timestamp) ?? null,
          durationSeconds:
            typeof data.durationSeconds === "number"
              ? (data.durationSeconds as number)
              : null,
          status: (data.status as string) ?? null,
          from: (data.from as string) ?? null,
          to: (data.to as string) ?? null,
          recordingUrl: (data.recordingUrl as string) ?? null,
          transcript: (data.transcript as string) ?? null,
        };
      });

      setRows(arr);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Failed to load calls from Firestore"
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadData();
  }, [assistantId, pageSize, start.getTime(), end.getTime()]);

  // -------- BILLING (plan + usage) ----------
  async function loadBillingPlan(): Promise<{
    planName: string;
    planMonthlyCalls: number;
    planMonthlyFee: number;
    planOverageFee: number;
    planStartMonth: string | null;
    planStartDate: Date | null;
  } | null> {
    setPlanLoading(true);
    setPlanError(null);
    try {
      const db = getFirestore(firebaseApp);

      const usersQ = query(
        collection(db, "users"),
        where("assistantId", "==", assistantId),
        limit(1)
      );
      const usersSnap = await getDocs(usersQ);
      if (usersSnap.empty) {
        setPlanError("No user profile found for this assistant.");
        setPlanLoading(false);
        return null;
      }

      const u = usersSnap.docs[0].data() as Record<string, any>;

      const _planName = String(u["Plan Name"] ?? u.planName ?? "—");
      const _planMonthlyCalls =
        typeof u["Plan Monthly Calls"] === "number"
          ? (u["Plan Monthly Calls"] as number)
          : typeof u.planMonthlyCalls === "number"
          ? (u.planMonthlyCalls as number)
          : 0;
      const _planMonthlyFee =
        typeof u["Plan Monthly Fee"] === "number"
          ? (u["Plan Monthly Fee"] as number)
          : typeof u.planMonthlyFee === "number"
          ? (u.planMonthlyFee as number)
          : 0;
      const _planOverageFee =
        typeof u["Plan Overage Fee"] === "number"
          ? (u["Plan Overage Fee"] as number)
          : typeof u.planOverageFee === "number"
          ? (u.planOverageFee as number)
          : 0;

      const rawStart =
        u["Plan Start Month"] ??
        u.planStartMonthTs ??
        u.planStartMonthMs ??
        u.planStartMonth;

      let _planStartDate: Date | null = null;
      let _planStartMonthLabel: string | null = null;

      if (rawStart && typeof rawStart?.toDate === "function") {
        _planStartDate = rawStart.toDate();
      } else if (typeof rawStart === "number" && isFinite(rawStart)) {
        _planStartDate = new Date(rawStart);
      } else if (typeof rawStart === "string") {
        const parsed = parsePlanStartMonth(rawStart);
        if (parsed) {
          _planStartDate = parsed;
        } else {
          _planStartMonthLabel = rawStart;
        }
      }

      if (_planStartDate) {
        _planStartDate = new Date(
          _planStartDate.getFullYear(),
          _planStartDate.getMonth(),
          1,
          0,
          0,
          0,
          0
        );
        _planStartMonthLabel = _planStartDate.toLocaleString(undefined, {
          month: "long",
          year: "numeric",
        });
      }

      setPlanName(_planName);
      setPlanMonthlyCalls(_planMonthlyCalls);
      setPlanMonthlyFee(_planMonthlyFee);
      setPlanOverageFee(_planOverageFee);
      setPlanStartMonth(_planStartMonthLabel);

      return {
        planName: _planName,
        planMonthlyCalls: _planMonthlyCalls,
        planMonthlyFee: _planMonthlyFee,
        planOverageFee: _planOverageFee,
        planStartMonth: _planStartMonthLabel,
        planStartDate: _planStartDate,
      };
    } catch (e) {
      setPlanError(
        e instanceof Error ? e.message : "Failed to load billing plan."
      );
      return null;
    } finally {
      setPlanLoading(false);
    }
  }

  async function loadBillingUsage() {
    try {
      const db = getFirestore(firebaseApp);
      const now = new Date();
      const ms = startOfMonth(now);
      const me = endOfMonth(now);

      const qy = query(
        collection(db, "callLogs"),
        where("assistantId", "==", assistantId),
        orderBy("startTime", "desc"),
        where("startTime", ">=", Timestamp.fromDate(ms)),
        where("startTime", "<=", Timestamp.fromDate(me))
      );
      const snap = await getDocs(qy);
      setCallsThisMonth(snap.size);
    } catch {
      setCallsThisMonth(0);
    }
  }

  useEffect(() => {
    void loadBillingPlan();
    void loadBillingUsage();
  }, [assistantId]);

  // KPI totals for log/hourly
  const totalCalls = rows.length;
  const totalMinutes = useMemo(
    () =>
      rows.reduce(
        (acc, it) => acc + minutesFromSeconds(it.durationSeconds),
        0
      ),
    [rows]
  );
  const avgMinutes = totalCalls ? totalMinutes / totalCalls : 0;

  // Hourly Analysis dataset (midnight → 11 PM)
  const hourlyData = useMemo(() => {
    const buckets = Array.from({ length: 24 }, (_, h) => ({
      hour: h,
      label: new Date(2000, 0, 1, h, 0, 0).toLocaleTimeString([], {
        hour: "numeric",
      }),
      calls: 0,
    }));
    rows.forEach((r) => {
      const d = tsToDate(r.startTime);
      if (!d) return;
      buckets[d.getHours()].calls += 1;
    });
    return buckets;
  }, [rows]);

  // Billing computations
  const monthLabel = useMemo(
    () =>
      new Date().toLocaleString(undefined, {
        month: "long",
        year: "numeric",
      }),
    []
  );
  const callBalance = planMonthlyCalls - callsThisMonth;
  const overageCount = Math.max(0, -callBalance);
  const overageAmount = overageCount * planOverageFee;

  // -------- Invoice History Loader --------
  async function loadInvoiceHistory(override?: {
    planName?: string;
    planMonthlyCalls?: number;
    planMonthlyFee?: number;
    planOverageFee?: number;
    planStartMonth?: string | null;
    planStartDate?: Date | null;
  }) {
    if (!override && (planLoading || planError)) return;

    setInvoiceLoading(true);
    setInvoiceError(null);
    try {
      const db = getFirestore(firebaseApp);
      const now = new Date();

      const pName = override?.planName ?? planName;
      const pCalls = override?.planMonthlyCalls ?? planMonthlyCalls;
      const pFee = override?.planMonthlyFee ?? planMonthlyFee;
      const pOver = override?.planOverageFee ?? planOverageFee;

      const pStartDate = override?.planStartDate ?? null;

      const parsedStart =
        pStartDate ??
        parsePlanStartMonth(
          override?.planStartMonth ?? planStartMonth ?? undefined
        );

      const startFromPlan = parsedStart ?? startOfMonth(now);
      const months = monthRangeInclusive(startFromPlan, now);

      const rows: InvoiceRow[] = [];
      for (const m of months) {
        const ms = startOfMonth(m);
        const me = endOfMonth(m);

        const qy = query(
          collection(db, "callLogs"),
          where("assistantId", "==", assistantId),
          orderBy("startTime", "desc"),
          where("startTime", ">=", Timestamp.fromDate(ms)),
          where("startTime", "<=", Timestamp.fromDate(me))
        );
        const snap = await getDocs(qy);
        const actualCalls = snap.size;

        const balance = pCalls - actualCalls;
        const overCount = Math.max(0, -balance);
        const overage = overCount * pOver;
        const total = pFee + overage;

        rows.push({
          month: fmtMonth(ms),
          planName: pName,
          planMonthlyFee: pFee,
          planMonthlyCalls: pCalls,
          actualCalls,
          callBalance: balance,
          callOverageFee: pOver,
          calculatedOverage: overage,
          totalInvoice: total,
        });
      }

      rows.reverse();
      setInvoiceRows(rows);
    } catch (e) {
      setInvoiceError(
        e instanceof Error ? e.message : "Failed to load invoice history."
      );
    } finally {
      setInvoiceLoading(false);
    }
  }

  async function loadRestaurantReputation() {
    setRestaurantRepLoading(true);
    setRestaurantRepError(null);
    setRestaurantPhase1(null);
    setRestaurantPhase2(null);
    setRestaurantComplaintTrends(null);
    setRestaurantAlerts([]);
    setReviewResponses(null);

    try {
      const restaurantCode = authCtx?.profile?.restaurantCode || null;

      if (!restaurantCode) return;

      const rtdb = getDatabase(firebaseApp);

      const [phase1Res, phase2Res, reviewResponsesSnap] = await Promise.all([
        fetch(
          `https://us-central1-askaida-dashboard.cloudfunctions.net/getRestaurantReputationPhase1?restaurantCode=${restaurantCode}`
        ),
        fetch(
          `https://us-central1-askaida-dashboard.cloudfunctions.net/getRestaurantReputationPhase2?restaurantCode=${restaurantCode}`
        ),
        get(
          dbRef(
            rtdb,
            `restaurants/${restaurantCode}/insights/reviewResponses/latest`
          )
        ),
      ]);

      const phase1Json = await phase1Res.json().catch(() => null);
      const phase2Json = await phase2Res.json().catch(() => null);

      if (!phase1Res.ok && !phase2Res.ok) {
        throw new Error("Failed to load restaurant reputation data.");
      }

      setRestaurantPhase1(phase1Json?.data || null);
      setRestaurantPhase2(phase2Json?.data || null);

      setRestaurantMeta({
        storedReviews:
          phase2Json?.data?.ops?.storedReviews ??
          phase1Json?.data?.ops?.storedReviews ??
          null,
        totalTextReviews:
          phase2Json?.data?.counts?.totalTextReviews ??
          phase1Json?.data?.counts?.totalTextReviews ??
          null,
      });

      setRestaurantComplaintTrends(phase2Json?.data?.complaintTrends || null);
      setRestaurantAlerts(phase2Json?.data?.alerts || []);
      setReviewResponses((reviewResponsesSnap.val() as ReviewResponsesPayload) || null);
    } catch (e) {
      setRestaurantRepError(
        e instanceof Error ? e.message : "Failed to load restaurant reputation."
      );
    } finally {
      setRestaurantRepLoading(false);
    }
  }

  async function handleCopyResponse(reviewId: string, draftResponse?: string | null) {
    try {
      await navigator.clipboard.writeText(String(draftResponse || ""));
      setCopiedReviewId(reviewId);
      window.setTimeout(() => setCopiedReviewId(null), 2000);
    } catch {
      setCopiedReviewId(null);
    }
  }

  useEffect(() => {
    if (view === "invoice") {
      (async () => {
        const fresh = await loadBillingPlan();
        await loadInvoiceHistory(fresh ?? undefined);
      })();
    }

    if (
      view === "restaurantPhase1" ||
      view === "restaurantPhase2" ||
      view === "respond"
    ) {
      void loadRestaurantReputation();
    }
  }, [view, assistantId]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-100 to-slate-200 p-6 md:p-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl md:text-3xl font-semibold text-slate-900">
            Assistant Dashboard
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Call analytics, billing, invoice history, and restaurant reputation
          </p>
        </div>

        <div className="hidden sm:flex items-center gap-2 rounded-full bg-white/80 border border-slate-200 px-3 py-1.5 shadow-sm">
          <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 inline-block" />
          <span className="text-sm text-slate-600">Live</span>
        </div>
      </div>

      {/* Plan info header */}
      <div className="rounded-2xl bg-white/90 backdrop-blur shadow-sm border border-slate-200 p-5 md:p-6 mb-6">
        {planLoading ? (
          <div className="text-sm text-gray-500">Loading plan…</div>
        ) : planError ? (
          <div className="text-sm text-red-600">{planError}</div>
        ) : (
          <div className="space-y-1 text-base">
            <div>
              <span className="font-medium">Plan Type</span> — {planName || "—"}
            </div>
            <div>
              <span className="font-medium">Plan Start Month</span> —{" "}
              {planStartMonth || "—"}
            </div>
          </div>
        )}
      </div>

      {/* Filters Row */}
      <div className="grid md:grid-cols-3 gap-3 items-end mb-6">
        <div>
          <label className="text-sm text-gray-600">Time Period</label>
          <select
            className="w-full border border-slate-300 bg-white rounded-lg px-3 py-2 mt-1 shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            value={preset}
            onChange={(e) => setPreset(e.target.value as PresetKey)}
          >
            {PRESETS.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="text-sm text-gray-600">Custom Start</label>
          <input
            type="datetime-local"
            className="w-full border border-slate-300 bg-white rounded-lg px-3 py-2 mt-1 shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            value={customStart}
            onChange={(e) => setCustomStart(e.target.value)}
            disabled={preset !== "custom"}
          />
        </div>

        <div>
          <label className="text-sm text-gray-600">Custom End</label>
          <input
            type="datetime-local"
            className="w-full border border-slate-300 bg-white rounded-lg px-3 py-2 mt-1 shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            value={customEnd}
            onChange={(e) => setCustomEnd(e.target.value)}
            disabled={preset !== "custom"}
          />
        </div>
      </div>

      {/* Actions Row */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 mb-5">
        <div className="flex items-center gap-3">
          <button
            onClick={syncNow}
            className="px-4 py-2 rounded-lg bg-blue-600 text-white font-medium shadow-sm hover:bg-blue-700 disabled:opacity-50"
            disabled={syncing}
          >
            {syncing ? "Syncing…" : "Sync now"}
          </button>
          {syncing && (
            <div className="text-sm text-blue-600">
              SYNC in PROGRESS. Please wait…
            </div>
          )}
        </div>

        <div className="ml-auto flex items-center gap-2">
          <span className="text-sm text-gray-600">View</span>
          <select
            className="border border-slate-300 bg-white rounded-lg px-3 py-2 shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            value={view}
            onChange={(e) => setView(e.target.value as ViewMode)}
          >
            <option value="log">Call Log</option>
            <option value="hourly">Hourly Analysis</option>
            <option value="billing">Billing</option>
            <option value="invoice">Invoice History</option>
            <option value="restaurantPhase1">
              Restaurant Reputation Phase 1
            </option>
            <option value="restaurantPhase2">
              Restaurant Reputation Phase 2
            </option>
            <option value="respond">Respond</option>
          </select>
        </div>
      </div>

      {/* KPIs */}
      {view !== "billing" && view !== "invoice" && view !== "respond" && (
        <>
          <div className="mb-2 text-gray-500 text-sm">
            <span className="opacity-80 font-medium">Metrics</span> —{" "}
            <span className="italic">For Selected Period</span>
          </div>
          <div className="grid sm:grid-cols-3 gap-4 mb-8">
            <KpiCard title="Number of Calls" value={nf(totalCalls)} />
            <KpiCard
              title="Total Minutes"
              value={nf(totalMinutes, {
                maximumFractionDigits: totalMinutes < 100 ? 1 : 0,
              })}
              subtitle="Sum of duration in minutes"
            />
            <KpiCard
              title="Average Call Length"
              value={nf(avgMinutes, { maximumFractionDigits: 2 })}
            />
          </div>
        </>
      )}

      {/* Conditional Views */}
      {view === "hourly" ? (
        <div className="rounded-2xl bg-white/95 backdrop-blur shadow-sm border border-slate-200 p-5 space-y-6">
          <div className="px-1 pb-3">
            <div className="font-medium">Hourly Analysis</div>
            <div className="text-sm text-gray-500">
              Calls grouped by call start time (hour)
            </div>
          </div>
          <div style={{ width: "100%", height: 320 }}>
            <ResponsiveContainer>
              <LineChart data={hourlyData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="label" />
                <YAxis allowDecimals={false} />
                <Tooltip />
                <Line
                  type="monotone"
                  dataKey="calls"
                  stroke="#3b82f6"
                  strokeWidth={2}
                  dot={{ r: 2 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      ) : view === "billing" ? (
        <div className="rounded-2xl bg-white/95 backdrop-blur shadow-sm border border-slate-200 p-5 space-y-6">
          <div>
            <div className="font-medium text-lg">Billing</div>
            <div className="text-sm text-gray-500">
              Plan details and this month’s usage
            </div>
          </div>

          {planLoading ? (
            <div className="text-gray-500">Loading plan…</div>
          ) : planError ? (
            <div className="text-red-600">{planError}</div>
          ) : (
            <>
              <div className="rounded-xl border bg-gray-50 p-4 space-y-2 text-sm">
                <div className="flex justify-between gap-4">
                  <span className="text-gray-600">Current Month/Year</span>
                  <span className="font-medium">{monthLabel}</span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-gray-600">Plan Name</span>
                  <span className="font-medium">{planName}</span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-gray-600">Plan Monthly Fee</span>
                  <span className="font-medium">{usd(planMonthlyFee)}</span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-gray-600">Plan Monthly Calls</span>
                  <span className="font-medium">{nf(planMonthlyCalls)}</span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-gray-600">Actual Monthly Calls</span>
                  <span className="font-medium">{nf(callsThisMonth)}</span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-gray-600">Call Balance</span>
                  <span
                    className={`font-medium ${
                      planMonthlyCalls - callsThisMonth < 0
                        ? "text-red-600"
                        : "text-green-700"
                    }`}
                  >
                    {nf(planMonthlyCalls - callsThisMonth)}
                  </span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-gray-600">Call Overage Fee</span>
                  <span className="font-medium">{usd(planOverageFee)}</span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-gray-600">Calculated Overage</span>
                  <span className="font-semibold">
                    {Math.max(0, callsThisMonth - planMonthlyCalls)} calls ·{" "}
                    {usd(
                      Math.max(0, callsThisMonth - planMonthlyCalls) *
                        planOverageFee
                    )}
                  </span>
                </div>
                {planStartMonth && (
                  <div className="flex justify-between gap-4">
                    <span className="text-gray-600">Plan Start Month</span>
                    <span className="font-medium">{planStartMonth}</span>
                  </div>
                )}
              </div>

              <div className="space-y-2">
                <div className="text-sm text-gray-600">
                  Monthly usage ({nf(callsThisMonth)} / {nf(planMonthlyCalls)})
                </div>
                <ProgressBar
                  pct={
                    planMonthlyCalls > 0
                      ? Math.min(100, (callsThisMonth / planMonthlyCalls) * 100)
                      : 0
                  }
                />
              </div>
            </>
          )}
        </div>
      ) : view === "invoice" ? (
        <div className="rounded-2xl bg-white/95 backdrop-blur shadow-sm border border-slate-200 overflow-hidden">
          <div className="px-5 py-4 border-b">
            <div className="font-medium">Invoice History</div>
            <div className="text-sm text-gray-500">
              Monthly invoices from plan start to current month
            </div>
          </div>

          {planError ? (
            <div className="p-5 text-red-600">{planError}</div>
          ) : invoiceLoading ? (
            <div className="p-5 text-gray-500">Loading invoice history…</div>
          ) : invoiceError ? (
            <div className="p-5 text-red-600">{invoiceError}</div>
          ) : invoiceRows.length === 0 ? (
            <div className="p-5 text-gray-400">No invoice data.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-slate-500 bg-slate-50">
                    <th className="py-2 px-3">Month</th>
                    <th className="py-2 px-3">Plan Name</th>
                    <th className="py-2 px-3 text-right">Plan Monthly Fee</th>
                    <th className="py-2 px-3 text-right">Plan Monthly Calls</th>
                    <th className="py-2 px-3 text-right">Actual Calls</th>
                    <th className="py-2 px-3 text-right">Call Balance</th>
                    <th className="py-2 px-3 text-right">Call Overage Fee</th>
                    <th className="py-2 px-3 text-right">
                      Calculated Overage
                    </th>
                    <th className="py-2 px-3 text-right">Total Invoice</th>
                  </tr>
                </thead>
                <tbody>
                  {invoiceRows.map((r, idx) => (
                    <tr
                      key={`${r.month}-${idx}`}
                      className="border-b last:border-0"
                    >
                      <td className="py-2 px-3 whitespace-nowrap text-sm">
                        {r.month}
                      </td>
                      <td className="py-2 px-3 text-sm">{r.planName}</td>
                      <td className="py-2 px-3 text-sm text-right">
                        {usd(r.planMonthlyFee)}
                      </td>
                      <td className="py-2 px-3 text-sm text-right">
                        {nf(r.planMonthlyCalls)}
                      </td>
                      <td className="py-2 px-3 text-sm text-right">
                        {nf(r.actualCalls)}
                      </td>
                      <td
                        className={`py-2 px-3 text-sm text-right ${
                          r.callBalance < 0 ? "text-red-600" : "text-green-700"
                        }`}
                      >
                        {nf(r.callBalance)}
                      </td>
                      <td className="py-2 px-3 text-sm text-right">
                        {usd(r.callOverageFee)}
                      </td>
                      <td className="py-2 px-3 text-sm text-right">
                        {usd(r.calculatedOverage)}
                      </td>
                      <td className="py-2 px-3 text-sm text-right font-medium">
                        {usd(r.totalInvoice)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : view === "restaurantPhase1" ? (
        <div className="rounded-2xl bg-emerald-50 backdrop-blur shadow-sm border border-emerald-200 p-5 space-y-6">
          <div>
            <div className="font-medium text-lg">
              Restaurant Reputation — Phase 1
            </div>
            <div className="text-sm text-gray-500">
              Narrative reputation summary for{" "}
              {restaurantPhase1?.restaurantDisplayName || "Restaurant"}
            </div>
          </div>

          {restaurantRepLoading ? (
            <div className="text-gray-500">Loading reputation analysis…</div>
          ) : restaurantRepError ? (
            <div className="text-red-600">{restaurantRepError}</div>
          ) : !restaurantPhase1 ? (
            <div className="text-gray-400">
              No Phase 1 restaurant reputation data.
            </div>
          ) : (
            <div className="space-y-5">
              <div className="rounded-xl border bg-white p-4">
                <div className="text-sm text-gray-500">Risk Level</div>
                <div className="text-2xl font-semibold mt-1">
                  {restaurantPhase1?.answers?.reputationRiskLevel || "N/A"}
                </div>
              </div>

              <div>
                <div className="font-medium mb-1">Consistent Complaints</div>
                <div className="text-sm text-gray-700">
                  {restaurantPhase1?.answers?.consistentComplaints || "—"}
                </div>
              </div>

              <div>
                <div className="font-medium mb-1">Rising Theme</div>
                <div className="text-sm text-gray-700">
                  {restaurantPhase1?.answers?.risingTheme || "—"}
                </div>
              </div>

              <div>
                <div className="font-medium mb-1">Brand Damage</div>
                <div className="text-sm text-gray-700">
                  {restaurantPhase1?.answers?.brandDamage || "—"}
                </div>
              </div>

              <div>
                <div className="font-medium mb-2">Fix Immediately</div>
                <div className="space-y-3">
                  {(restaurantPhase1?.answers?.fixImmediately || []).map(
                    (x: any, i: number) => (
                      <div key={i} className="rounded-xl border p-3 bg-white">
                        <div className="font-medium">
                          {typeof x === "string" ? x : x?.issue || "Fix"}
                        </div>
                        {typeof x !== "string" && x?.evidence ? (
                          <div className="text-xs text-gray-500 mt-1">
                            {x.evidence}
                          </div>
                        ) : null}
                      </div>
                    )
                  )}
                </div>
              </div>

              <div>
                <div className="font-medium mb-2">Requires Capital</div>
                <div className="space-y-3">
                  {(restaurantPhase1?.answers?.requiresCapital || []).map(
                    (x: any, i: number) => (
                      <div key={i} className="rounded-xl border p-3 bg-white">
                        <div className="font-medium">
                          {typeof x === "string"
                            ? x
                            : x?.issue || "Capital Item"}
                        </div>
                        {typeof x !== "string" && x?.evidence ? (
                          <div className="text-xs text-gray-500 mt-1">
                            {x.evidence}
                          </div>
                        ) : null}
                      </div>
                    )
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      ) : view === "restaurantPhase2" ? (
        <div className="rounded-2xl bg-yellow-50 backdrop-blur shadow-sm border border-yellow-200 p-5 space-y-6">
          <div>
            <div className="font-medium text-lg text-yellow-900">
              Restaurant Reputation — Phase 2
            </div>
            <div className="text-sm text-gray-500">
              Trend and theme analysis for{" "}
              {restaurantPhase2?.restaurantDisplayName || "Restaurant"}
            </div>
          </div>

          {restaurantRepLoading ? (
            <div className="text-gray-500">Loading reputation analysis…</div>
          ) : restaurantRepError ? (
            <div className="text-red-600">{restaurantRepError}</div>
          ) : !restaurantPhase2 ? (
            <div className="text-gray-400">
              No Phase 2 restaurant reputation data.
            </div>
          ) : (
            <div className="space-y-5">
              <div className="grid sm:grid-cols-3 gap-4">
                <div className="rounded-xl border bg-gray-50 p-4">
                  <div className="text-sm text-gray-500">Risk Level</div>
                  <div className="text-2xl font-semibold mt-1">
                    {restaurantPhase2?.trend?.riskLevel || "N/A"}
                  </div>
                </div>

                <div className="rounded-xl border bg-gray-50 p-4">
                  <div className="text-sm text-gray-500">
                    Written Reviews Analyzed
                  </div>
                  <div className="text-2xl font-semibold mt-1">
                    {restaurantPhase2?.counts?.totalTextReviews ?? "0"}
                  </div>
                </div>

                <div className="rounded-xl border bg-gray-50 p-4">
                  <div className="text-sm text-gray-500">Average Rating</div>
                  <div className="text-2xl font-semibold mt-1">
                    {restaurantPhase2?.counts?.avgRating ?? "—"}
                  </div>
                </div>
              </div>

              {restaurantComplaintTrends?.topTags?.length > 0 && (
                <div className="rounded-xl border bg-white p-4">
                  <div className="text-sm text-gray-500 mb-3">
                    Top Complaint Categories
                  </div>

                  <div className="grid sm:grid-cols-3 gap-3">
                    {restaurantComplaintTrends.topTags
                      .slice(0, 3)
                      .map((tag: any, i: number) => (
                        <div key={i} className="rounded-lg border bg-gray-50 p-3">
                          <div className="text-sm text-gray-500">
                            {tag?.label || tag?.key || "Category"}
                          </div>
                          <div className="text-2xl font-semibold mt-1">
                            {tag?.count ?? 0}
                          </div>
                        </div>
                      ))}
                  </div>
                </div>
              )}

              {restaurantComplaintTrends?.topPattern?.length > 0 && (
                <div className="rounded-xl border bg-white p-4">
                  <div className="text-sm text-gray-500 mb-3">
                    Top Complaint Patterns
                  </div>

                  <div className="space-y-2">
                    {restaurantComplaintTrends.topPattern
                      .slice(0, 3)
                      .map((pattern: any, i: number) => (
                        <div
                          key={i}
                          className="flex items-center justify-between rounded-lg border bg-gray-50 p-3"
                        >
                          <div>
                            <div className="font-medium text-sm">
                              {pattern?.label || pattern?.pattern || "Pattern"}
                            </div>
                            <div className="text-xs text-gray-500 mt-1">
                              {pattern?.typeLabel || pattern?.type || "—"}
                            </div>
                          </div>

                          <div className="text-lg font-semibold">
                            {pattern?.count ?? 0}
                          </div>
                        </div>
                      ))}
                  </div>
                </div>
              )}

              {restaurantComplaintTrends?.sources &&
                Object.keys(restaurantComplaintTrends.sources).length > 0 && (
                  <div className="rounded-xl border bg-white p-4">
                    <div className="text-sm text-gray-500 mb-3">
                      Complaint Sources
                    </div>

                    <div className="space-y-2">
                      {Object.entries(restaurantComplaintTrends.sources).map(
                        ([source, count]: any) => (
                          <div
                            key={source}
                            className="flex items-center justify-between rounded-lg border bg-gray-50 p-3"
                          >
                            <div className="text-sm capitalize">{source}</div>
                            <div className="text-lg font-semibold">
                              {count ?? 0}
                            </div>
                          </div>
                        )
                      )}
                    </div>
                  </div>
                )}

              {restaurantComplaintTrends?.byTypeSource &&
                Object.keys(restaurantComplaintTrends.byTypeSource).length > 0 && (
                  <div className="rounded-xl border bg-white p-4">
                    <div className="text-sm text-gray-500 mb-3">
                      Complaint Type by Source
                    </div>

                    <div className="space-y-3">
                      {Object.entries(restaurantComplaintTrends.byTypeSource).map(
                        ([type, sourceMap]: any) => (
                          <div
                            key={type}
                            className="rounded-lg border bg-gray-50 p-3"
                          >
                            <div className="font-medium text-sm">
                              {String(type)
                                .replace(/_/g, " ")
                                .toLowerCase()
                                .replace(/\b\w/g, (c) => c.toUpperCase())}
                            </div>

                            <div className="mt-2 space-y-1">
                              {Object.entries(sourceMap || {}).map(
                                ([source, count]: any) => (
                                  <div
                                    key={source}
                                    className="flex items-center justify-between text-sm"
                                  >
                                    <span className="capitalize">{source}</span>
                                    <span className="font-medium">
                                      {count ?? 0}
                                    </span>
                                  </div>
                                )
                              )}
                            </div>
                          </div>
                        )
                      )}
                    </div>
                  </div>
                )}

              <div>
                <div className="font-medium mb-2">Active Alerts</div>

                {restaurantAlerts.length === 0 ? (
                  <div className="rounded-xl border p-3 bg-gray-50 text-sm text-gray-500">
                    No active alerts.
                  </div>
                ) : (
                  <div className="space-y-3">
                    {restaurantAlerts.map((alert: any, i: number) => {
                      const severity = String(alert?.severity || "").toUpperCase();

                      const boxClass =
                        severity === "HIGH"
                          ? "rounded-xl border p-3 bg-red-50 border-red-200"
                          : severity === "MEDIUM"
                          ? "rounded-xl border p-3 bg-amber-50 border-amber-200"
                          : "rounded-xl border p-3 bg-blue-50 border-blue-200";

                      const badgeClass =
                        severity === "HIGH"
                          ? "bg-red-100 text-red-700"
                          : severity === "MEDIUM"
                          ? "bg-amber-100 text-amber-700"
                          : "bg-blue-100 text-blue-700";

                      return (
                        <div key={i} className={boxClass}>
                          <div className="flex items-center justify-between gap-3">
                            <div className="font-medium text-sm">
                              {alert?.message || "Alert"}
                            </div>
                            <div
                              className={`text-xs font-semibold px-2 py-1 rounded-full ${badgeClass}`}
                            >
                              {severity || "INFO"}
                            </div>
                          </div>

                          {alert?.type ? (
                            <div className="text-xs text-gray-500 mt-2">
                              {alert.type}
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              <div>
                <div className="font-medium mb-1">Executive Summary</div>
                <div className="text-sm text-gray-700">
                  {restaurantPhase2?.narrative?.executiveSummary || "—"}
                </div>
              </div>

              {restaurantComplaintTrends && (
                <div className="space-y-4">
                  <div className="font-medium">Complaint Trends</div>

                  {restaurantComplaintTrends?.topTags?.length > 0 && (
                    <div>
                      <div className="text-sm text-gray-500 mb-2">
                        Top Complaint Categories
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {restaurantComplaintTrends.topTags.map(
                          (tag: any, i: number) => (
                            <div
                              key={i}
                              className="px-3 py-1 rounded-full bg-red-50 border border-red-200 text-sm"
                            >
                              {tag?.label || tag?.key || "Category"} (
                              {tag?.count ?? 0})
                            </div>
                          )
                        )}
                      </div>
                    </div>
                  )}

                  {restaurantComplaintTrends?.topPattern?.length > 0 && (
                    <div>
                      <div className="text-sm text-gray-500 mb-2">Top Issues</div>
                      <div className="space-y-2">
                        {restaurantComplaintTrends.topPattern.map(
                          (p: any, i: number) => (
                            <div
                              key={i}
                              className="flex items-center justify-between border rounded-lg p-2 text-sm"
                            >
                              <div>
                                <div className="font-medium">
                                  {p?.label || p?.pattern || "Pattern"}
                                </div>
                                <div className="text-xs text-gray-500">
                                  {p?.typeLabel || p?.type || "—"}
                                </div>
                              </div>
                              <div className="font-semibold">{p?.count ?? 0}</div>
                            </div>
                          )
                        )}
                      </div>
                    </div>
                  )}

                  <div className="text-xs text-gray-500">
                    {restaurantComplaintTrends?.totals?.matchedItems || 0} total
                    complaint matches across{" "}
                    {restaurantComplaintTrends?.totals?.uniqueTypes || 0} categories
                  </div>
                </div>
              )}

              <div className="rounded-xl border border-blue-200 bg-blue-50 p-4">
                <div className="text-sm font-medium text-blue-900">
                  Weekly Change Signal
                </div>
                <div className="text-sm text-blue-800 mt-1">
                  {restaurantPhase2?.narrative?.whatChangedThisWeek ||
                    "No major weekly change detected."}
                </div>
              </div>

              <div>
                <div className="font-medium mb-1">What Changed This Week</div>
                <div className="text-sm text-gray-700">
                  {restaurantPhase2?.narrative?.whatChangedThisWeek || "—"}
                </div>
              </div>

              <div>
                <div className="font-medium mb-2">Top Risks</div>
                <div className="space-y-3">
                  {(restaurantPhase2?.narrative?.topRisks || []).map(
                    (x: any, i: number) => (
                      <div key={i} className="rounded-xl border p-3 bg-gray-50">
                        <div className="font-medium">
                          {x?.risk || x?.theme || "Risk"}
                        </div>
                        <div className="text-sm text-gray-700 mt-1">
                          {x?.impact || "—"}
                        </div>

                        {Array.isArray(x?.evidence) ? (
                          <div className="text-xs text-gray-500 mt-2 space-y-1">
                            {x.evidence.map((ev: any, j: number) => (
                              <div key={j}>{typeof ev === "string" ? ev : "—"}</div>
                            ))}
                          </div>
                        ) : (
                          <div className="text-xs text-gray-500 mt-1">
                            {x?.evidence || "—"}
                          </div>
                        )}
                      </div>
                    )
                  )}
                </div>
              </div>

              <div>
                <div className="font-medium mb-2">Top Fixes (No Capex)</div>
                <div className="space-y-3">
                  {(restaurantPhase2?.narrative?.topFixesNoCapex || []).map(
                    (x: any, i: number) => (
                      <div key={i} className="rounded-lg border p-3 bg-gray-50">
                        <div className="font-medium">
                          {x?.fix || x?.theme || "Fix"}
                        </div>

                        {Array.isArray(x?.targets) ? (
                          <div className="text-sm text-gray-700 mt-2">
                            Targets: {x.targets.join(" · ")}
                          </div>
                        ) : x?.impact ? (
                          <div className="text-sm text-gray-700 mt-1">
                            {x.impact}
                          </div>
                        ) : null}

                        {Array.isArray(x?.tiesToEvidence) ? (
                          <div className="text-xs text-gray-500 mt-2 space-y-1">
                            {x.tiesToEvidence.map((ev: any, j: number) => (
                              <div key={j}>{typeof ev === "string" ? ev : "—"}</div>
                            ))}
                          </div>
                        ) : x?.evidence ? (
                          <div className="text-xs text-gray-500 mt-1">
                            {x.evidence}
                          </div>
                        ) : null}
                      </div>
                    )
                  )}
                </div>
              </div>

              <div>
                <div className="font-medium mb-2">
                  Recommended Actions — Next 7 Days
                </div>
                <div className="space-y-3">
                  {(restaurantPhase2?.narrative?.recommendedOwnerActions7d || []).length === 0 ? (
                    <div className="rounded-xl border p-3 bg-gray-50 text-sm text-gray-500">
                      No 7-day actions available.
                    </div>
                  ) : (
                    (restaurantPhase2?.narrative?.recommendedOwnerActions7d || []).map(
                      (x: any, i: number) => (
                        <div key={i} className="rounded-xl border p-3 bg-white">
                          <div className="font-medium">
                            {x?.action || `Action ${i + 1}`}
                          </div>
                          <div className="text-sm text-gray-700 mt-1">
                            {x?.details || x?.why || "—"}
                          </div>
                          <div className="text-xs text-gray-500 mt-1">
                            Success Metric: {x?.successMetric || x?.expectedOutcome || "—"}
                          </div>
                        </div>
                      )
                    )
                  )}
                </div>
              </div>

              <div>
                <div className="font-medium mb-2">
                  Recommended Actions — Next 30 Days
                </div>
                <div className="space-y-3">
                  {(restaurantPhase2?.narrative?.recommendedOwnerActions30d || []).length === 0 ? (
                    <div className="rounded-xl border p-3 bg-gray-50 text-sm text-gray-500">
                      No 30-day actions available.
                    </div>
                  ) : (
                    (restaurantPhase2?.narrative?.recommendedOwnerActions30d || []).map(
                      (x: any, i: number) => (
                        <div key={i} className="rounded-xl border p-3 bg-white">
                          <div className="font-medium">
                            {x?.action || `Action ${i + 1}`}
                          </div>
                          <div className="text-sm text-gray-700 mt-1">
                            {x?.details || x?.why || "—"}
                          </div>
                          <div className="text-xs text-gray-500 mt-1">
                            Success Metric: {x?.successMetric || x?.expectedOutcome || "—"}
                          </div>
                        </div>
                      )
                    )
                  )}
                </div>
              </div>

              <div>
                <div className="font-medium mb-2">Rising Themes</div>
                <div className="space-y-3">
                  {(restaurantPhase2?.trend?.risingThemes || []).length === 0 ? (
                    <div className="rounded-xl border p-3 bg-gray-50 text-sm text-gray-500">
                      No rising themes detected.
                    </div>
                  ) : (
                    (restaurantPhase2?.trend?.risingThemes || []).map(
                      (t: any, i: number) => (
                        <div key={i} className="rounded-xl border p-3 bg-gray-50">
                          <div className="font-medium">
                            {t?.title || t?.themeId || "Theme"}
                          </div>
                          <div className="text-sm text-gray-600 mt-1">
                            Mentions: {t?.mentions ?? 0} · Last 7d:{" "}
                            {t?.mentionsLast7d ?? 0} · Prior:{" "}
                            {t?.mentionsPrior23d ?? 0}
                          </div>
                        </div>
                      )
                    )
                  )}
                </div>
              </div>

              {restaurantMeta && (
                <div className="text-xs text-gray-500">
                  Reviews stored: {restaurantMeta?.storedReviews ?? "—"} · Text
                  reviews analyzed: {restaurantMeta?.totalTextReviews ?? "—"}
                </div>
              )}
            </div>
          )}
        </div>
      ) : view === "respond" ? (
        <div className="rounded-2xl bg-white/95 backdrop-blur shadow-sm border border-slate-200 p-5 space-y-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="font-medium text-lg">Respond</div>
              <div className="text-sm text-gray-500">
                Draft responses for negative customer reviews
              </div>
            </div>

            <div className="text-sm text-slate-500">
              {reviewResponses?.totalNegativeReviews ?? 0} negative review
              {(reviewResponses?.totalNegativeReviews ?? 0) === 1 ? "" : "s"}
            </div>
          </div>

          {restaurantRepLoading ? (
            <div className="text-gray-500">Loading response drafts…</div>
          ) : restaurantRepError ? (
            <div className="text-red-600">{restaurantRepError}</div>
          ) : !reviewResponses?.items?.length ? (
            <div className="rounded-xl border bg-slate-50 p-4 text-sm text-slate-500">
              No response drafts available yet.
            </div>
          ) : (
            <div className="space-y-4">
              {reviewResponses.items.map((item, i) => (
                <div
                  key={item.reviewId || `review-${i}`}
                  className="rounded-2xl border border-slate-200 bg-white shadow-sm p-5 space-y-4"
                >
                  <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="inline-flex items-center rounded-full bg-red-50 text-red-700 px-2.5 py-1 text-xs font-semibold border border-red-100">
                          {item.rating ?? "—"}-Star Review
                        </span>
                        <div className="text-sm font-medium text-slate-800">
                            {item.authorName || "Customer"}
                        </div>
                        {item.source ? (
                          <span className="inline-flex items-center rounded-full bg-slate-100 text-slate-700 px-2.5 py-1 text-xs font-medium capitalize">
                            {item.source}
                          </span>
                        ) : null}
                        <span className="text-xs text-slate-500">
                          Review Date: {item.date ? fmtDateFromString(item.date) : "—"}
                        </span>
                      </div>

                      {Array.isArray(item.issueTags) && item.issueTags.length > 0 ? (
                        <div className="flex flex-wrap gap-2">
                          {item.issueTags.map((tag) => (
                            <span
                              key={tag}
                              className="inline-flex items-center rounded-full bg-amber-50 text-amber-800 px-2.5 py-1 text-xs font-medium border border-amber-100"
                            >
                              {String(tag).replace(/_/g, " ")}
                            </span>
                          ))}
                        </div>
                      ) : null}
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        onClick={() =>
                          handleCopyResponse(
                            item.reviewId,
                            item.draftResponse || ""
                          )
                        }
                        className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                      >
                        {copiedReviewId === item.reviewId
                          ? "Copied"
                          : "Copy Response"}
                      </button>

                      <button
                        disabled
                        className="rounded-xl border border-slate-200 bg-slate-100 px-3 py-2 text-sm font-medium text-slate-400 cursor-not-allowed"
                        title="Regenerate will be added later"
                      >
                        Regenerate
                      </button>
                    </div>
                  </div>

                  <div className="rounded-2xl bg-slate-50 border border-slate-200 p-4">
                    <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">
                      Customer Review
                    </div>
                    <div className="text-sm text-slate-700 leading-6 whitespace-pre-wrap">
                      {item.text || "—"}
                    </div>
                  </div>

                  <div className="rounded-2xl bg-white border border-slate-200 p-4">
                    <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">
                      Draft Response
                    </div>
                    <div className="text-sm text-slate-800 leading-6 whitespace-pre-wrap">
                      {item.draftResponse || "—"}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="rounded-2xl bg-green-50 backdrop-blur shadow-sm border border-green-200 overflow-hidden">
          <div className="px-5 py-4 border-b">
            <div className="font-medium">Call Log</div>
            <div className="text-sm text-gray-500">
              For the selected date or date range
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-full">
              <thead>
                <tr className="text-left text-xs uppercase text-gray-500">
                  <th className="py-2 px-3">Date</th>
                  <th className="py-2 px-3">Customer Phone</th>
                  <th className="py-2 px-3">Start Time</th>
                  <th className="py-2 px-3 text-right">Duration</th>
                  <th className="py-2 px-3 text-right">Transcript</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td className="py-6 px-3 text-gray-500" colSpan={5}>
                      Loading…
                    </td>
                  </tr>
                ) : error ? (
                  <tr>
                    <td className="py-6 px-3 text-red-600" colSpan={5}>
                      {error}
                    </td>
                  </tr>
                ) : rows.length === 0 ? (
                  <tr>
                    <td className="py-6 px-3 text-gray-400" colSpan={5}>
                      No calls in this period.
                    </td>
                  </tr>
                ) : (
                  <>
                    {displayedRows.map((it) => {
                      const mins = it.durationSeconds
                        ? Math.round(it.durationSeconds / 60)
                        : 0;

                      return (
                        <tr
                          key={it.id}
                          className="border-b border-slate-100 last:border-0 hover:bg-slate-50/80 transition-colors"
                        >
                          <td className="py-2 px-3 whitespace-nowrap text-sm">
                            {fmtDate(it.startTime)}
                          </td>
                          <td className="py-2 px-3 text-sm">
                            {it.from || "—"}
                          </td>
                          <td className="py-2 px-3 text-sm">
                            {fmtTime(it.startTime)}
                          </td>
                          <td className="py-2 px-3 text-sm text-right">
                            {mins} min
                          </td>
                          <td className="py-2 px-3 text-sm text-right">
                            <button
                              className="underline"
                              onClick={() => setDrawerId(it.id)}
                            >
                              View
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Drawer */}
      {drawerId && (
        <div
          className="fixed inset-0 bg-black/30 flex"
          onClick={() => setDrawerId(null)}
        >
          <div
            className="ml-auto w-full max-w-xl h-full bg-white p-5 overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-3">
              <div className="text-lg font-semibold">
                Call {drawerId.slice(0, 8)}…
              </div>
              <button
                className="px-3 py-1 rounded-xl border"
                onClick={() => setDrawerId(null)}
              >
                Close
              </button>
            </div>

            {(() => {
              const d = rows.find((r) => r.id === drawerId);
              if (!d) return <div className="text-gray-500">No details.</div>;
              const mins = d.durationSeconds
                ? Math.round(d.durationSeconds / 60)
                : 0;

              return (
                <div className="space-y-3 text-sm">
                  <div>
                    <span className="text-gray-500">Date:</span>{" "}
                    {fmtDate(d.startTime)}
                  </div>
                  <div>
                    <span className="text-gray-500">Start:</span>{" "}
                    {fmtTime(d.startTime)}
                  </div>
                  <div>
                    <span className="text-gray-500">Duration:</span>{" "}
                    {mins ? `${mins} min` : "—"}
                  </div>
                  <div>
                    <span className="text-gray-500">From:</span>{" "}
                    {d.from || "—"}{" "}
                    <span className="text-gray-500 ml-2">To:</span>{" "}
                    {d.to || "—"}
                  </div>
                  
<div className="flex gap-4 items-center">
  <a
    className="underline"
    href={`/api/vapi/recording?callId=${encodeURIComponent(d.id)}`}
    target="_blank"
    rel="noreferrer"
  >
    Play Recording
  </a>

  <a
    className="underline"
    href={`/api/vapi/recording?callId=${encodeURIComponent(d.id)}`}
    download={`heysue-call-${d.id}.wav`}
  >
    Download Recording
  </a>
</div>

                  {d.transcript && (
                    <div>
                      <div className="text-gray-500 mb-1">Transcript</div>
                      <div className="whitespace-pre-wrap bg-gray-50 border rounded-xl p-3 max-h-80 overflow-auto">
                        {d.transcript}
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}
          </div>
        </div>
      )}

      <div className="text-xs text-gray-400 mt-3">
        Window: {start.toLocaleString()} → {end.toLocaleString()}
      </div>
    </div>
  );
}