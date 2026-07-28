'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { onAuthStateChanged, signOut } from 'firebase/auth';
import { get, onValue, ref, update } from 'firebase/database';
import { doc, getDoc } from 'firebase/firestore';
import { auth, db, firestore } from '@/lib/firebaseClient';

type GatewayRecord = {
  gatewayID?: string;
  locationID?: string;
  status?: string;
  online?: boolean;
  activated?: boolean;
  assigned?: boolean;
  lastHeartbeat?: string | number;
  softwareVersion?: string;

  printer?: {
    status?: string;
    model?: string;
    ipAddress?: string;
    port?: number;
  };
};

type GatewayRow = GatewayRecord & {
  gatewayKey: string;
};

type RestaurantOption = {
  locationID: string;
  restaurantName: string;
};

export default function AdminGatewaysPage() {
  const router = useRouter();

  const [checkingAuth, setCheckingAuth] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);
  const [error, setError] = useState('');

  const [loadingGateways, setLoadingGateways] = useState(true);
  const [gateways, setGateways] = useState<GatewayRow[]>([]);
  const [restaurants, setRestaurants] = useState<RestaurantOption[]>([]);
  const [selectedGateway, setSelectedGateway] =
  useState<GatewayRow | null>(null);

  useEffect(() => {
    const unsubscribeAuth = onAuthStateChanged(
      auth,
      async (user) => {
        if (!user) {
          router.replace('/admin/login');
          return;
        }

        try {
          const adminSnapshot = await getDoc(
            doc(firestore, 'adminUsers', user.uid)
          );

          if (!adminSnapshot.exists()) {
            setError('You do not have admin access.');
            setIsAdmin(false);
            return;
          }

          const adminData = adminSnapshot.data();

          if (
            adminData?.active !== true ||
            adminData?.role !== 'admin'
          ) {
            setError('You do not have admin access.');
            setIsAdmin(false);
            return;
          }

          setIsAdmin(true);
        } catch (err) {
          console.error(
            'Gateway admin auth check failed:',
            err
          );

          setError('Failed to verify admin access.');
          setIsAdmin(false);
        } finally {
          setCheckingAuth(false);
        }
      }
    );

    return () => unsubscribeAuth();
  }, [router]);

  useEffect(() => {
    if (!isAdmin) {
      return;
    }

    setLoadingGateways(true);

    const gatewaysRef = ref(db, 'gateways');

    const unsubscribeGateways = onValue(
      gatewaysRef,
      (snapshot) => {
        const value = snapshot.exists()
          ? snapshot.val()
          : {};

        const rows: GatewayRow[] = Object.entries(
          value || {}
        ).map(([gatewayKey, gatewayValue]) => ({
          gatewayKey,
          ...((gatewayValue || {}) as GatewayRecord),
        }));

        rows.sort((a, b) =>
          String(
            a.gatewayID || a.gatewayKey
          ).localeCompare(
            String(b.gatewayID || b.gatewayKey)
          )
        );

        setGateways(rows);
        setLoadingGateways(false);
      },
      (firebaseError) => {
        console.error(
          'Failed to load gateways:',
          firebaseError
        );

        setError('Failed to load gateway records.');
        setLoadingGateways(false);
      }
    );

    return () => unsubscribeGateways();
  }, [isAdmin]);

  useEffect(() => {
    if (!isAdmin) {
      return;
    }

    const loadRestaurants = async () => {
      try {
        const restaurantsSnapshot = await get(
          ref(db, 'restaurants')
        );

        if (!restaurantsSnapshot.exists()) {
          setRestaurants([]);
          return;
        }

        const value = restaurantsSnapshot.val() || {};

        const restaurantRows: RestaurantOption[] =
          Object.entries(value).map(
            ([locationID, restaurantValue]) => {
              const restaurant =
                (restaurantValue || {}) as Record<
                  string,
                  unknown
                >;

              return {
                locationID,
                restaurantName: String(
                  restaurant.restaurantName ||
                    restaurant.displayName ||
                    restaurant.name ||
                    locationID
                ),
              };
            }
          );

        restaurantRows.sort((a, b) =>
          a.restaurantName.localeCompare(
            b.restaurantName
          )
        );

        setRestaurants(restaurantRows);
      } catch (err) {
        console.error(
          'Failed to load restaurants:',
          err
        );

        setError('Failed to load restaurant records.');
      }
    };

    loadRestaurants();
  }, [isAdmin]);

  const onlineCount = useMemo(
    () =>
      gateways.filter(
        (gateway) => gateway.online === true
      ).length,
    [gateways]
  );

  const unassignedCount = useMemo(
    () =>
      gateways.filter(
        (gateway) =>
          !String(gateway.locationID || '').trim()
      ).length,
    [gateways]
  );

  const activatedCount = useMemo(
    () =>
      gateways.filter(
        (gateway) => gateway.activated === true
      ).length,
    [gateways]
  );

  const handleLogout = async () => {
    try {
      await signOut(auth);
      router.push('/admin/login');
    } catch (err) {
      console.error('Logout failed:', err);
    }
  };

const handleAssignGateway = (
  gateway: GatewayRow
) => {
  setSelectedGateway(gateway);
};

const assignGatewayToRestaurant = async (
  locationID: string
) => {
  if (!selectedGateway) {
    return;
  }

  try {
    const gatewayID =
      selectedGateway.gatewayID ||
      selectedGateway.gatewayKey;

    await update(
      ref(
        db,
        `gateways/${selectedGateway.gatewayKey}`
      ),
      {
        gatewayID,
        locationID,
        assigned: true,
        status: 'assigned',
      }
    );

    setSelectedGateway(null);
  } catch (err) {
    console.error(
      'Failed to assign gateway:',
      err
    );

    setError(
      'Failed to assign gateway to restaurant.'
    );
  }
};

const requestPrinterDiscovery = async (
  gateway: GatewayRow
) => {
  try {
    const requestedAt = new Date().toISOString();

    await update(
      ref(db, `gateways/${gateway.gatewayKey}`),
      {
        'printer/status': 'discovery_requested',
        'commands/discoverPrinter/requested': true,
        'commands/discoverPrinter/status': 'pending',
        'commands/discoverPrinter/requestedAt':
          requestedAt,
      }
    );
  } catch (err) {
    console.error(
      'Failed to request printer discovery:',
      err
    );

    setError(
      'Failed to request printer discovery.'
    );
  }
};

  if (checkingAuth) {
    return (
      <div className="min-h-screen bg-slate-50 p-6">
        <div className="mx-auto max-w-6xl rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="text-sm text-slate-500">
            Checking admin access…
          </div>
        </div>
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="min-h-screen bg-slate-50 p-6">
        <div className="mx-auto max-w-4xl rounded-2xl border border-red-200 bg-white p-6 shadow-sm">
          <div className="text-lg font-semibold text-red-600">
            Access denied
          </div>

          <div className="mt-2 text-sm text-slate-600">
            {error ||
              'You do not have permission to view this page.'}
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="min-h-screen bg-slate-50 p-6">
      <div className="mx-auto max-w-7xl space-y-6">
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <div className="text-2xl font-semibold text-slate-900">
                HeySue Gateways
              </div>

              <div className="mt-2 text-sm text-slate-500">
                Assign gateway devices, discover printers,
                send test prints, and activate automatic
                kitchen printing.
              </div>
            </div>

            <div className="flex flex-wrap gap-3">
              <Link
                href="/admin"
                className="inline-flex rounded-xl border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                ← Dashboard
              </Link>

              <button
                type="button"
                onClick={handleLogout}
                className="inline-flex rounded-xl border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Logout
              </button>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="text-sm text-slate-500">
              Registered
            </div>

            <div className="mt-2 text-3xl font-semibold text-slate-900">
              {gateways.length}
            </div>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="text-sm text-slate-500">
              Online
            </div>

            <div className="mt-2 text-3xl font-semibold text-emerald-600">
              {onlineCount}
            </div>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="text-sm text-slate-500">
              Unassigned
            </div>

            <div className="mt-2 text-3xl font-semibold text-amber-600">
              {unassignedCount}
            </div>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="text-sm text-slate-500">
              Activated
            </div>

            <div className="mt-2 text-3xl font-semibold text-blue-600">
              {activatedCount}
            </div>
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-200 px-6 py-4">
            <div className="text-lg font-semibold text-slate-900">
              Gateway Devices
            </div>

            <div className="mt-1 text-sm text-slate-500">
              Devices will appear automatically after
              connecting to the HeySue cloud.
            </div>
          </div>

          {loadingGateways ? (
            <div className="p-6 text-sm text-slate-500">
              Loading gateways…
            </div>
          ) : error ? (
            <div className="p-6 text-sm text-red-600">
              {error}
            </div>
          ) : gateways.length === 0 ? (
            <div className="p-6">
              <div className="text-lg font-semibold text-slate-900">
                No gateways registered yet
              </div>

              <div className="mt-2 text-sm text-slate-500">
                Plug a configured HeySue Gateway into
                Ethernet and power. It will appear here
                automatically when it connects.
              </div>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50">
                  <tr className="text-left text-slate-600">
                    <th className="px-6 py-3 font-medium">
                      Gateway ID
                    </th>

                    <th className="px-6 py-3 font-medium">
                      Restaurant
                    </th>

                    <th className="px-6 py-3 font-medium">
                      Gateway Status
                    </th>

                    <th className="px-6 py-3 font-medium">
                      Printer
                    </th>

                    <th className="px-6 py-3 font-medium">
                      Version
                    </th>

                    <th className="px-6 py-3 font-medium">
                      Last Heartbeat
                    </th>

                    <th className="px-6 py-3 font-medium">
                      Actions
                    </th>
                  </tr>
                </thead>

                <tbody>
                  {gateways.map((gateway) => {
                    const gatewayID =
                      gateway.gatewayID ||
                      gateway.gatewayKey;

                    const isAssigned = Boolean(
                      String(
                        gateway.locationID || ''
                      ).trim()
                    );

                    return (
                      <tr
                        key={gateway.gatewayKey}
                        className="border-t border-slate-100 hover:bg-slate-50"
                      >
                        <td className="px-6 py-4 font-medium text-slate-900">
                          {gatewayID}
                        </td>

                        <td className="px-6 py-4 text-slate-700">
                          {gateway.locationID ||
                            'Unassigned'}
                        </td>

                        <td className="px-6 py-4">
                          <span
                            className={
                              gateway.online
                                ? 'rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-medium text-emerald-700'
                                : 'rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700'
                            }
                          >
                            {gateway.online
                              ? 'Online'
                              : 'Offline'}
                          </span>
                        </td>

                        <td className="px-6 py-4 text-slate-700">
                          {gateway.printer?.model ||
                            gateway.printer?.status ||
                            'Not discovered'}
                        </td>

                        <td className="px-6 py-4 text-slate-700">
                          {gateway.softwareVersion ||
                            '—'}
                        </td>

                        <td className="px-6 py-4 text-slate-700">
                          {gateway.lastHeartbeat
                            ? String(
                                gateway.lastHeartbeat
                              )
                            : '—'}
                        </td>

                        <td className="px-6 py-4">
                          {!isAssigned ? (
                            <button
                              type="button"
                              onClick={() =>
                                handleAssignGateway(
                                  gateway
                                )
                              }
                              className="inline-flex rounded-xl bg-blue-600 px-3 py-2 font-medium text-white hover:bg-blue-500"
                            >
                              Assign Gateway
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() =>
                                requestPrinterDiscovery(
                                  gateway
                                )
                              }
                              className="inline-flex rounded-xl bg-violet-600 px-3 py-2 font-medium text-white hover:bg-violet-500"
                            >
                              Discover Printer
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
      </div>

      {selectedGateway && (
  <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
    <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl">
      <div className="text-xl font-semibold text-slate-900">
        Assign Gateway
      </div>

      <div className="mt-2 text-sm text-slate-500">
        Select the restaurant for{' '}
        <span className="font-medium text-slate-700">
          {selectedGateway.gatewayID ||
            selectedGateway.gatewayKey}
        </span>
        .
      </div>

      <div className="mt-6 space-y-3">
        {restaurants.length === 0 ? (
          <div className="rounded-xl border border-slate-200 p-4 text-sm text-slate-500">
            No restaurant records were found.
          </div>
        ) : (
          restaurants.map((restaurant) => (
            <button
              key={restaurant.locationID}
              type="button"
              onClick={() =>
                assignGatewayToRestaurant(
                  restaurant.locationID
                )
              }
              className="flex w-full items-center justify-between rounded-xl border border-slate-200 px-4 py-3 text-left hover:border-blue-400 hover:bg-blue-50"
            >
              <span className="font-medium text-slate-900">
                {restaurant.restaurantName}
              </span>

              <span className="text-sm text-slate-500">
                {restaurant.locationID}
              </span>
            </button>
          ))
        )}
      </div>

      <div className="mt-6 flex justify-end">
        <button
          type="button"
          onClick={() => setSelectedGateway(null)}
          className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          Cancel
        </button>
      </div>
    </div>
  </div>
)}
    </>
  );

}