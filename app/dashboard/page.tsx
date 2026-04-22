// app/dashboard/page.tsx
"use client";

import React from "react";
import { useAuth } from "@/components/AuthProvider";
import AssistantDashboardVapi from "@/components/AssistantDashboardVapi";
const DASHBOARD_VERSION = "v1.3.0";

export default function DashboardPage() {
  const { loading, profile, error, signOutUser } = useAuth();

  if (loading) {
    return (
      <div className="p-6 text-sm text-gray-500">
        Loading your account…
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6 text-sm text-red-600">
        {error}
      </div>
    );
  }

  if (!profile) {
    // Profile not found (rare if you created it already)
    return (
      <div className="p-6 text-sm text-gray-700">
        No profile found. Please contact support.
      </div>
    );
  }

  if (!profile.assistantId) {
    // ✅ Avoid throwing on first paint; show a friendly message instead
    return (
      <div className="p-6 text-sm text-gray-700">
        No assistant configured for your account yet. If this is a new account,
        try again in a moment or refresh.
      </div>
    );
  }

  return (
    <div className="p-0">
      {/* Header with restaurant name + sign out */}
      <div className="flex items-center justify-between p-6 border-b bg-white">
        <div>
          <div className="text-2xl font-bold">
            {profile.restaurantName || profile.name || "—"}
          </div>
          <div className="text-xs text-gray-400">
            {DASHBOARD_VERSION}
          </div>
        </div>

  <button
    onClick={signOutUser}
    className="text-sm px-4 py-2 rounded-lg border bg-gray-50 hover:bg-gray-100"
  >
    Sign Out
  </button>
</div>

      <AssistantDashboardVapi assistantId={profile.assistantId} />
    </div>
  );
}
