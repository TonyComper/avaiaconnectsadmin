'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { onAuthStateChanged } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { auth, firestore } from '@/lib/firebaseClient';

export default function NewRestaurantPage() {
  const router = useRouter();

  const [checkingAuth, setCheckingAuth] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);

  const [restaurantCode, setRestaurantCode] = useState('');
  const [restaurantName, setRestaurantName] = useState('');
  const [assistantId, setAssistantId] = useState('');
  const [timeZone, setTimeZone] = useState('');
  const [googlePlaceId, setGooglePlaceId] = useState('');
  const [opentableUrl, setOpentableUrl] = useState('');

  const [planMonthlyCalls, setPlanMonthlyCalls] = useState('');
  const [planMonthlyFee, setPlanMonthlyFee] = useState('');
  const [planName, setPlanName] = useState('');
  const [planOverageFee, setPlanOverageFee] = useState('');
  const [planStartMonth, setPlanStartMonth] = useState('');

  const [apifyStoreUrl, setApifyStoreUrl] = useState('');
  const [email, setEmail] = useState('');
  const [contactPhoneNumber, setContactPhoneNumber] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [platform1, setPlatform1] = useState('');

  const [submitting, setSubmitting] = useState(false);
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError('');

    const normalizedRestaurantCode = restaurantCode.trim().toLowerCase();

    try {
      const res = await fetch(
        'https://us-central1-askaida-dashboard.cloudfunctions.net/createRestaurantOnboarding',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            restaurantCode: normalizedRestaurantCode,
            restaurantName: restaurantName.trim(),
            assistantId: assistantId.trim(),
            timeZone: timeZone.trim(),
            googlePlaceId: googlePlaceId.trim(),
            opentableUrl: opentableUrl.trim(),
            userDocId: normalizedRestaurantCode,

            planMonthlyCalls,
            planMonthlyFee,
            planName: planName.trim(),
            planOverageFee,
            planStartMonth: planStartMonth.trim(),

            apifyStoreUrl: apifyStoreUrl.trim(),
            email: email.trim(),
            contactPhoneNumber: contactPhoneNumber.trim(),
            name: name.trim(),
            password: password.trim(),
            platform1: platform1.trim(),
          }),
        }
      );

      const rawText = await res.text();
      console.log('createRestaurantOnboarding raw response:', rawText);

      let json: any = {};
      try {
        json = rawText ? JSON.parse(rawText) : {};
      } catch (e) {
        console.error('Failed to parse JSON response:', e);
      }

      if (!res.ok || json?.ok === false) {
        throw new Error(json?.error || rawText || 'Onboarding failed');
      }

      alert('Restaurant onboarding completed');
      router.push(`/admin/restaurants/${normalizedRestaurantCode}`);
    } catch (err: any) {
      console.error(err);
      setError(err?.message || 'Failed to onboard restaurant');
    } finally {
      setSubmitting(false);
    }
  };

  if (checkingAuth) {
    return <div className="p-6">Checking access...</div>;
  }

  if (!isAdmin) {
    return <div className="p-6 text-red-600">{error || 'Access denied'}</div>;
  }

  return (
    <div className="min-h-screen bg-slate-50 p-6">
      <div className="mx-auto max-w-4xl space-y-6">
        <div className="rounded-2xl border bg-white p-6 shadow-sm">
          <div className="text-2xl font-semibold">Add New Restaurant</div>
          <div className="text-sm text-slate-500">
            Create a new restaurant and run onboarding
          </div>
        </div>

        <form
          onSubmit={handleSubmit}
          className="space-y-6 rounded-2xl border bg-white p-6 shadow-sm"
        >
          <div>
            <div className="mb-4 text-lg font-semibold text-slate-900">
              Core Onboarding
            </div>

            <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
              <div>
                <label className="mb-1 block text-sm font-medium text-slate-700">
                  Restaurant Code
                </label>
                <input
                  type="text"
                  value={restaurantCode}
                  onChange={(e) => setRestaurantCode(e.target.value)}
                  placeholder="example: testrest1"
                  className="w-full rounded-xl border border-slate-300 px-4 py-3 outline-none focus:border-slate-500"
                  required
                />
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium text-slate-700">
                  Restaurant Name
                </label>
                <input
                  type="text"
                  value={restaurantName}
                  onChange={(e) => setRestaurantName(e.target.value)}
                  placeholder="example: Delicacies Gourmet"
                  className="w-full rounded-xl border border-slate-300 px-4 py-3 outline-none focus:border-slate-500"
                  required
                />
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium text-slate-700">
                  Assistant ID
                </label>
                <input
                  type="text"
                  value={assistantId}
                  onChange={(e) => setAssistantId(e.target.value)}
                  placeholder="example: 4bc33326-9c0f-463b-a455-76191aef3238"
                  className="w-full rounded-xl border border-slate-300 px-4 py-3 outline-none focus:border-slate-500"
                  required
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
                  placeholder="example: America/New_York"
                  className="w-full rounded-xl border border-slate-300 px-4 py-3 outline-none focus:border-slate-500"
                  required
                />
              </div>

              <div className="md:col-span-2">
                <label className="mb-1 block text-sm font-medium text-slate-700">
                  Google Place ID
                </label>
                <input
                  type="text"
                  value={googlePlaceId}
                  onChange={(e) => setGooglePlaceId(e.target.value)}
                  placeholder="example: ChIJ8w4jtyaGwokREVQe36M4C48"
                  className="w-full rounded-xl border border-slate-300 px-4 py-3 outline-none focus:border-slate-500"
                  required
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
            </div>
          </div>

          <div>
            <div className="mb-4 text-lg font-semibold text-slate-900">
              Plan / Billing
            </div>

            <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
              <div>
                <label className="mb-1 block text-sm font-medium text-slate-700">
                  Plan Monthly Calls
                </label>
                <input
                  type="number"
                  value={planMonthlyCalls}
                  onChange={(e) => setPlanMonthlyCalls(e.target.value)}
                  placeholder="example: 100"
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
                  placeholder="example: 99.99"
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
                  placeholder="example: Starter"
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
                  placeholder="example: 0.50"
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
                  placeholder="example: 2026-04"
                  className="w-full rounded-xl border border-slate-300 px-4 py-3 outline-none focus:border-slate-500"
                />
              </div>
            </div>
          </div>

          <div>
            <div className="mb-4 text-lg font-semibold text-slate-900">
              Platform / Contact
            </div>

            <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
              <div className="md:col-span-2">
                <label className="mb-1 block text-sm font-medium text-slate-700">
                  Apify Store URL
                </label>
                <input
                  type="text"
                  value={apifyStoreUrl}
                  onChange={(e) => setApifyStoreUrl(e.target.value)}
                  placeholder="example: https://www.ubereats.com/ca/store/..."
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
                  placeholder="example: owner@restaurant.com"
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
                  placeholder="example: 4165551234"
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
                  placeholder="example: Joe Papa"
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
                  placeholder="example: 654321"
                  className="w-full rounded-xl border border-slate-300 px-4 py-3 outline-none focus:border-slate-500"
                />
              </div>

              <div className="md:col-span-2">
                <label className="mb-1 block text-sm font-medium text-slate-700">
                  Platform1
                </label>
                <input
                  type="text"
                  value={platform1}
                  onChange={(e) => setPlatform1(e.target.value)}
                  placeholder="example: uber_eats"
                  className="w-full rounded-xl border border-slate-300 px-4 py-3 outline-none focus:border-slate-500"
                />
              </div>
            </div>
          </div>

          {error ? (
            <div className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-600">
              {error}
            </div>
          ) : null}

          <div className="flex flex-wrap gap-3">
            <button
              type="submit"
              disabled={submitting}
              className="rounded-xl bg-emerald-600 px-4 py-3 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-60"
            >
              {submitting ? 'Creating…' : 'Create & Onboard Restaurant'}
            </button>

            <button
              type="button"
              onClick={() => router.push('/admin/restaurants')}
              className="rounded-xl border border-slate-300 px-4 py-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}