'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { onAuthStateChanged, signOut } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { auth, firestore } from '@/lib/firebaseClient';

export default function AdminHomePage() {
  const router = useRouter();

  const [checkingAuth, setCheckingAuth] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        router.replace('/admin/login');
        return;
      }

      try {
        const snap = await getDoc(doc(firestore, 'adminUsers', user.uid));

        if (!snap.exists()) {
          setError('You do not have admin access.');
          setCheckingAuth(false);
          return;
        }

        const data = snap.data();

        if (data?.active !== true || data?.role !== 'admin') {
          setError('You do not have admin access.');
          setCheckingAuth(false);
          return;
        }

        setIsAdmin(true);
      } catch (err) {
        console.error('Admin auth check failed:', err);
        setError('Failed to verify admin access.');
      } finally {
        setCheckingAuth(false);
      }
    });

    return () => unsub();
  }, [router]);

  const handleLogout = async () => {
    try {
      await signOut(auth);
      router.push('/admin/login');
    } catch (err) {
      console.error('Logout failed:', err);
    }
  };

  if (checkingAuth) {
    return (
      <div className="min-h-screen bg-slate-50 p-6">
        <div className="mx-auto max-w-5xl rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="text-sm text-slate-500">Checking admin access…</div>
        </div>
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="min-h-screen bg-slate-50 p-6">
        <div className="mx-auto max-w-4xl rounded-2xl border border-red-200 bg-white p-6 shadow-sm">
          <div className="text-lg font-semibold text-red-600">Access denied</div>
          <div className="mt-2 text-sm text-slate-600">
            {error || 'You do not have permission to view this page.'}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 p-6">
      <div className="mx-auto max-w-6xl space-y-6">
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <div className="text-3xl font-semibold text-slate-900">Admin Dashboard</div>
              <div className="mt-2 text-sm text-slate-500">
                Internal operations for restaurant onboarding, configuration, reputation, and reporting.
              </div>
            </div>

            <button
              onClick={handleLogout}
              className="inline-flex rounded-xl border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Logout
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          <Link
            href="/admin/restaurants"
            className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition hover:bg-slate-50"
          >
            <div className="text-lg font-semibold text-slate-900">Restaurants</div>
            <div className="mt-2 text-sm text-slate-500">
              View all restaurants, open detail pages, review config, and manage operations.
            </div>
          </Link>

          <Link
            href="/admin/restaurants/new"
            className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition hover:bg-slate-50"
          >
            <div className="text-lg font-semibold text-slate-900">Add New Restaurant</div>
            <div className="mt-2 text-sm text-slate-500">
              Create a new restaurant record and run onboarding from the admin dashboard.
            </div>
          </Link>

          <Link
  href="/admin/gateways"
  className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition hover:bg-slate-50"
>
  <div className="text-lg font-semibold text-slate-900">
    Gateways
  </div>

  <div className="mt-2 text-sm text-slate-500">
    Assign gateway devices, discover printers, send test prints, and activate automatic kitchen printing.
  </div>
</Link>

        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="text-lg font-semibold text-slate-900">Next Admin Modules</div>
          <div className="mt-3 space-y-2 text-sm text-slate-600">
            <div>Firestore + RTDB side-by-side editor</div>
            <div>Refresh reputation and rebuild actions</div>
            <div>Voice complaint analytics and VAPI assistant mapping</div>
            <div>Billing and reporting summaries</div>
          </div>
        </div>
      </div>
    </div>
  );
}