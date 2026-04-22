'use client';

import React, { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { onAuthStateChanged, signOut } from 'firebase/auth';
import { get, ref, update } from 'firebase/database';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { auth, db, firestore } from '@/lib/firebaseClient';

export default function RestaurantDetailPage() {
  const params = useParams();
  const router = useRouter();

  const restaurantCode = params?.restaurantCode as string;

  const [checkingAuth, setCheckingAuth] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [data, setData] = useState<any>(null);
  const [showRaw, setShowRaw] = useState(false);

  const [assistantId, setAssistantId] = useState('');
  const [timeZone, setTimeZone] = useState('');
  const [opentableUrl, setOpentableUrl] = useState('');

  const [planMonthlyCalls, setPlanMonthlyCalls] = useState('');
  const [planMonthlyFee, setPlanMonthlyFee] = useState('');
  const [planName, setPlanName] = useState('');
  const [planOverageFee, setPlanOverageFee] = useState('');
  const [planStartMonth, setPlanStartMonth] = useState('');

  const [email, setEmail] = useState('');
  const [contactPhoneNumber, setContactPhoneNumber] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        router.replace('/admin/login');
        return;
      }

      try {
        const snap = await getDoc(doc(firestore, 'adminUsers', user.uid));

        if (!snap.exists()) {
          setError('No admin access');
          setCheckingAuth(false);
          return;
        }

        const d = snap.data();

        if (d?.active !== true || d?.role !== 'admin') {
          setError('No admin access');
          setCheckingAuth(false);
          return;
        }

        setIsAdmin(true);
      } catch (err) {
        console.error(err);
        setError('Auth check failed');
      } finally {
        setCheckingAuth(false);
      }
    });

    return () => unsub();
  }, [router]);

  useEffect(() => {
    if (!isAdmin || !restaurantCode) return;

    const load = async () => {
      setLoading(true);
      setError('');

      try {
        const [rtdbSnap, userSnap] = await Promise.all([
          get(ref(db, `restaurants/${restaurantCode}`)),
          getDoc(doc(firestore, 'users', restaurantCode)),
        ]);

        const rtdbData = rtdbSnap.exists() ? rtdbSnap.val() : null;
        const userData = userSnap.exists() ? userSnap.data() : null;

        if (!rtdbData && !userData) {
          setError('Restaurant not found');
          setLoading(false);
          return;
        }

        const merged = {
          rtdb: rtdbData || {},
          user: userData || {},
        };

        setData(merged);

        const config = rtdbData?.config || {};
        const reputation = config?.reputation || {};

        setAssistantId(String(userData?.assistantId || config?.assistantId || ''));
        setTimeZone(String(config?.timeZone || ''));
        setOpentableUrl(String(reputation?.opentableUrl || ''));

        setPlanMonthlyCalls(
          userData?.planMonthlyCalls != null ? String(userData.planMonthlyCalls) : ''
        );
        setPlanMonthlyFee(
          userData?.planMonthlyFee != null ? String(userData.planMonthlyFee) : ''
        );
        setPlanName(String(userData?.planName || ''));
        setPlanOverageFee(
          userData?.planOverageFee != null ? String(userData.planOverageFee) : ''
        );
        setPlanStartMonth(String(userData?.planStartMonth || ''));

        setEmail(String(userData?.email || ''));
        setContactPhoneNumber(String(userData?.contactPhoneNumber || ''));
        setName(String(userData?.name || ''));
        setPassword(String(userData?.password || ''));
      } catch (err) {
        console.error(err);
        setError('Failed to load restaurant');
      } finally {
        setLoading(false);
      }
    };

    load();
  }, [isAdmin, restaurantCode]);

  const reloadRestaurant = async () => {
    const [rtdbSnap, userSnap] = await Promise.all([
      get(ref(db, `restaurants/${restaurantCode}`)),
      getDoc(doc(firestore, 'users', restaurantCode)),
    ]);

    const rtdbData = rtdbSnap.exists() ? rtdbSnap.val() : null;
    const userData = userSnap.exists() ? userSnap.data() : null;

    setData({
      rtdb: rtdbData || {},
      user: userData || {},
    });
  };

  const handleLogout = async () => {
    try {
      await signOut(auth);
      router.push('/admin/login');
    } catch (err) {
      console.error('Logout failed:', err);
    }
  };

  const handleRefreshReputation = async () => {
    if (!restaurantCode) return;

    setRefreshing(true);

    try {
      const res = await fetch(
        `https://us-central1-askaida-dashboard.cloudfunctions.net/refreshRestaurantReputation?restaurantCode=${restaurantCode}`,
        {
          method: 'POST',
        }
      );

      const rawText = await res.text();
      console.log('refreshRestaurantReputation raw response:', rawText);

      let json: any = {};
      try {
        json = rawText ? JSON.parse(rawText) : {};
      } catch (e) {
        console.error('Failed to parse refresh JSON response:', e);
      }

      if (!res.ok || json?.ok === false) {
        throw new Error(json?.error || rawText || 'Failed to refresh reputation');
      }

      alert('Reputation refresh completed');
      await reloadRestaurant();
    } catch (err: any) {
      console.error(err);
      alert(err?.message || 'Failed to refresh reputation');
    } finally {
      setRefreshing(false);
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!restaurantCode) return;

    setSaving(true);
    setError('');

    try {
      const rtdbConfigUpdates = {
        assistantId: assistantId.trim(),
        timeZone: timeZone.trim(),
      };

      const rtdbReputationUpdates = {
        opentableUrl: opentableUrl.trim(),
      };

      const firestoreUpdates = {
        assistantId: assistantId.trim(),
        restaurantCode,
        planMonthlyCalls: Number(planMonthlyCalls || 0),
        planMonthlyFee: Number(planMonthlyFee || 0),
        planName: planName.trim(),
        planOverageFee: Number(planOverageFee || 0),
        planStartMonth: planStartMonth.trim(),
        email: email.trim(),
        contactPhoneNumber: contactPhoneNumber.trim(),
        name: name.trim(),
        password: password.trim(),
      };

      await Promise.all([
        update(ref(db, `restaurants/${restaurantCode}/config`), rtdbConfigUpdates),
        update(
          ref(db, `restaurants/${restaurantCode}/config/reputation`),
          rtdbReputationUpdates
        ),
        setDoc(doc(firestore, 'users', restaurantCode), firestoreUpdates, {
          merge: true,
        }),
      ]);

      alert('Restaurant updated successfully');
      await reloadRestaurant();
    } catch (err: any) {
      console.error(err);
      setError(err?.message || 'Failed to save restaurant');
      alert(err?.message || 'Failed to save restaurant');
    } finally {
      setSaving(false);
    }
  };

  if (checkingAuth) {
    return <div className="p-6">Checking access...</div>;
  }

  if (!isAdmin) {
    return <div className="p-6 text-red-600">{error || 'Access denied'}</div>;
  }

  if (loading) {
    return <div className="p-6">Loading restaurant...</div>;
  }

  if (error) {
    return <div className="p-6 text-red-600">{error}</div>;
  }

  const rtdbData = data?.rtdb || {};
  const userData = data?.user || {};
  const config = rtdbData?.config || {};
  const reputation = config?.reputation || {};

  return (
    <div className="min-h-screen bg-slate-50 p-6">
      <div className="mx-auto max-w-6xl space-y-6">
        <div className="rounded-2xl border bg-white p-6 shadow-sm">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <div className="text-2xl font-semibold">{restaurantCode}</div>
              <div className="text-sm text-slate-500">Restaurant detail view</div>
            </div>

            <div className="flex flex-wrap gap-3">
              <button
                onClick={() => router.push('/admin/restaurants')}
                className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                ← Restaurants
              </button>

              <button
                onClick={handleRefreshReputation}
                disabled={refreshing}
                className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-60"
              >
                {refreshing ? 'Refreshing…' : 'Refresh Reputation'}
              </button>

              <button
                onClick={handleLogout}
                className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Logout
              </button>
            </div>
          </div>
        </div>

        <form onSubmit={handleSave} className="space-y-6">
          <div className="rounded-2xl border bg-white p-6 shadow-sm">
            <div className="mb-4 text-lg font-semibold">Editable Fields</div>

            <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
              <div>
                <label className="mb-1 block text-sm font-medium text-slate-700">
                  Assistant ID
                </label>
                <input
                  type="text"
                  value={assistantId}
                  onChange={(e) => setAssistantId(e.target.value)}
                  className="w-full rounded-xl border border-slate-300 px-4 py-3 outline-none focus:border-slate-500"
                />
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium text-slate-700">
                  Time Zone
                </label>
                <input
                  type="text"
                  value={timeZone}
                  onChange={(e) => setTimeZone(e.target.value)}
                  className="w-full rounded-xl border border-slate-300 px-4 py-3 outline-none focus:border-slate-500"
                />
              </div>

              <div className="md:col-span-2">
                <label className="mb-1 block text-sm font-medium text-slate-700">
                  OpenTable URL
                </label>
                <input
                  type="text"
                  value={opentableUrl}
                  onChange={(e) => setOpentableUrl(e.target.value)}
                  placeholder="example: https://www.opentable.ca/r/joey-sherway-toronto"
                  className="w-full rounded-xl border border-slate-300 px-4 py-3 outline-none focus:border-slate-500"
                />
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium text-slate-700">
                  Plan Monthly Calls
                </label>
                <input
                  type="number"
                  value={planMonthlyCalls}
                  onChange={(e) => setPlanMonthlyCalls(e.target.value)}
                  className="w-full rounded-xl border border-slate-300 px-4 py-3 outline-none focus:border-slate-500"
                />
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium text-slate-700">
                  Plan Monthly Fee
                </label>
                <input
                  type="number"
                  step="0.01"
                  value={planMonthlyFee}
                  onChange={(e) => setPlanMonthlyFee(e.target.value)}
                  className="w-full rounded-xl border border-slate-300 px-4 py-3 outline-none focus:border-slate-500"
                />
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium text-slate-700">
                  Plan Name
                </label>
                <input
                  type="text"
                  value={planName}
                  onChange={(e) => setPlanName(e.target.value)}
                  className="w-full rounded-xl border border-slate-300 px-4 py-3 outline-none focus:border-slate-500"
                />
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium text-slate-700">
                  Plan Overage Fee
                </label>
                <input
                  type="number"
                  step="0.01"
                  value={planOverageFee}
                  onChange={(e) => setPlanOverageFee(e.target.value)}
                  className="w-full rounded-xl border border-slate-300 px-4 py-3 outline-none focus:border-slate-500"
                />
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium text-slate-700">
                  Plan Start Month
                </label>
                <input
                  type="text"
                  value={planStartMonth}
                  onChange={(e) => setPlanStartMonth(e.target.value)}
                  className="w-full rounded-xl border border-slate-300 px-4 py-3 outline-none focus:border-slate-500"
                />
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium text-slate-700">
                  Email
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full rounded-xl border border-slate-300 px-4 py-3 outline-none focus:border-slate-500"
                />
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium text-slate-700">
                  Contact Phone Number
                </label>
                <input
                  type="text"
                  value={contactPhoneNumber}
                  onChange={(e) => setContactPhoneNumber(e.target.value)}
                  className="w-full rounded-xl border border-slate-300 px-4 py-3 outline-none focus:border-slate-500"
                />
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium text-slate-700">
                  Name
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full rounded-xl border border-slate-300 px-4 py-3 outline-none focus:border-slate-500"
                />
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium text-slate-700">
                  Password
                </label>
                <input
                  type="text"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full rounded-xl border border-slate-300 px-4 py-3 outline-none focus:border-slate-500"
                />
              </div>
            </div>
          </div>

          <div className="rounded-2xl border bg-white p-6 shadow-sm">
            <div className="mb-4 flex items-center justify-between">
              <div className="text-lg font-semibold">Current Data</div>
              <button
                type="button"
                onClick={() => setShowRaw((v) => !v)}
                className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                {showRaw ? 'Hide Raw' : 'Show Raw'}
              </button>
            </div>

            <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
              <div className="rounded-xl bg-slate-50 p-4">
                <div className="mb-2 text-sm font-semibold text-slate-700">RTDB Config</div>
                <div className="space-y-1 text-sm text-slate-600">
                  <div>
                    <span className="font-medium">Assistant ID:</span> {String(config?.assistantId || '')}
                  </div>
                  <div>
                    <span className="font-medium">Time Zone:</span> {String(config?.timeZone || '')}
                  </div>
                  <div>
                    <span className="font-medium">Google Place ID:</span>{' '}
                    {String(reputation?.googlePlaceId || '')}
                  </div>
                  <div>
                    <span className="font-medium">Uber Eats Store URL:</span>{' '}
                    {String(reputation?.uberEatsStoreUrl || '')}
                  </div>
                  <div>
                    <span className="font-medium">OpenTable URL:</span>{' '}
                    {String(reputation?.opentableUrl || '')}
                  </div>
                </div>
              </div>

              <div className="rounded-xl bg-slate-50 p-4">
                <div className="mb-2 text-sm font-semibold text-slate-700">Firestore User</div>
                <div className="space-y-1 text-sm text-slate-600">
                  <div>
                    <span className="font-medium">Email:</span> {String(userData?.email || '')}
                  </div>
                  <div>
                    <span className="font-medium">Name:</span> {String(userData?.name || '')}
                  </div>
                  <div>
                    <span className="font-medium">Phone:</span>{' '}
                    {String(userData?.contactPhoneNumber || '')}
                  </div>
                  <div>
                    <span className="font-medium">Plan Name:</span> {String(userData?.planName || '')}
                  </div>
                  <div>
                    <span className="font-medium">Plan Start Month:</span>{' '}
                    {String(userData?.planStartMonth || '')}
                  </div>
                </div>
              </div>
            </div>

            {showRaw ? (
              <pre className="mt-6 overflow-x-auto rounded-xl bg-slate-950 p-4 text-xs text-slate-100">
                {JSON.stringify(data, null, 2)}
              </pre>
            ) : null}
          </div>

          <div className="flex flex-wrap gap-3">
            <button
              type="submit"
              disabled={saving}
              className="rounded-xl bg-emerald-600 px-4 py-3 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-60"
            >
              {saving ? 'Saving…' : 'Save Changes'}
            </button>

            <button
              type="button"
              onClick={() => router.push('/admin/restaurants')}
              className="rounded-xl border border-slate-300 px-4 py-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Back to Restaurants
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}