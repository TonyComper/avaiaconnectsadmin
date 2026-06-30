// app/login/page.tsx
"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/components/AuthProvider";

import {
  getAuth,
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
} from "firebase/auth";
import { app as firebaseApp } from "@/lib/firebase";

export default function LoginPage() {
  const router = useRouter();
  const authCtx = useAuth() as any;

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [resetMsg, setResetMsg] = useState<string | null>(null);
  const [resetLoading, setResetLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setResetMsg(null);
    setLoading(true);

    try {
      if (typeof authCtx?.signInApp === "function") {
        await authCtx.signInApp(email, password);
      } else if (typeof authCtx?.login === "function") {
        await authCtx.login(email, password);
      } else if (typeof authCtx?.signIn === "function") {
        await authCtx.signIn(email, password);
      } else {
        const auth = getAuth(firebaseApp);
        await signInWithEmailAndPassword(auth, email, password);
      }

      router.push("/dashboard");
    } catch (err: any) {
      const msg =
        err?.code === "auth/invalid-credential"
          ? "Invalid email or password."
          : "Sign-in failed. Please try again.";
      setError(msg);
    } finally {
      setLoading(false);
    }
  }

  async function handleForgotPassword(e: React.MouseEvent) {
    e.preventDefault();
    setError(null);
    setResetMsg(null);

    if (!email) {
      setError("Enter your email above, then click “Forgot password?”");
      return;
    }

    try {
      setResetLoading(true);
      const auth = getAuth(firebaseApp);
      await sendPasswordResetEmail(auth, email);
      setResetMsg(
        "If an account exists for that email, a reset link has been sent."
      );
    } catch (err: any) {
      setError("Could not send reset email. Please check the address.");
    } finally {
      setResetLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex flex-col justify-center items-center bg-[#f5f5f5] px-4">
      <div className="w-full max-w-md bg-white p-6 rounded-2xl shadow-lg border border-gray-100">
        {/* Logo */}
        <div className="flex flex-col items-center mb-6">
          <img src="/logo1.png" alt="HeySue Logo" className="h-36 w-auto" />
        </div>

        {/* Divider */}
        <div className="flex items-center gap-4 mb-6">
          <div className="h-px bg-[#f04423] flex-1 opacity-40" />
          <div className="text-[#f04423] text-xl">🍴</div>
          <div className="h-px bg-[#f04423] flex-1 opacity-40" />
        </div>

        {/* Heading */}
        <h1 className="text-3xl font-bold text-center mb-6 text-black">
          Log in
        </h1>

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-5">
          <div>
            <label className="block text-sm font-semibold text-black mb-2">
              Email
            </label>
            <input
              type="email"
              placeholder="owner@restaurant.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full border-2 border-[#f04423] rounded-xl p-3 bg-white text-black focus:outline-none focus:ring-2 focus:ring-[#f04423]/30"
              required
              autoComplete="email"
            />
          </div>

          <div>
            <label className="block text-sm font-semibold text-black mb-2">
              Password
            </label>
            <input
              type="password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full border-2 border-[#f04423] rounded-xl p-3 bg-white text-black focus:outline-none focus:ring-2 focus:ring-[#f04423]/30"
              required
              autoComplete="current-password"
            />
          </div>

          {error && <p className="text-red-600 text-sm">{error}</p>}
          {resetMsg && <p className="text-green-700 text-sm">{resetMsg}</p>}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-3 rounded-xl bg-[#f04423] text-white font-bold hover:bg-[#d93618] disabled:opacity-70 transition"
          >
            {loading ? "Signing in…" : "Log in"}
          </button>
        </form>

        {/* Forgot password */}
        <div className="mt-5">
          <button
            onClick={handleForgotPassword}
            disabled={resetLoading}
            className="w-full py-3 rounded-xl border-2 border-[#f04423] text-[#f04423] font-semibold hover:bg-[#fff3ef] disabled:opacity-60 transition"
            type="button"
          >
            {resetLoading ? "Sending…" : "Forgot password?"}
          </button>
        </div>

        <p className="mt-6 text-center text-xs text-gray-500">
          Secure login • Your data is protected
        </p>
      </div>
    </div>
  );
}