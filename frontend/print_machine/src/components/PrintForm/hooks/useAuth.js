// hooks/useAuth.js
import { useState, useEffect, useCallback } from "react";

const API_BASE = process.env.REACT_APP_API_BASE || "https://uploadsnapprints-production.up.railway.app/api";
const AUTH_STORAGE_KEY = "snapprints_auth";

async function apiLoginOrRegister(mobile) {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mobile }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Login failed");
  return data; // { status: "otp_sent" } or { status: "logged_in", token, user }
}

async function apiVerifyOtp(mobile, otp) {
  const res = await fetch(`${API_BASE}/auth/verify-otp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mobile, otp }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Invalid OTP");
  return data; // { status: "logged_in", token, user }
}

async function apiResendOtp(mobile) {
  const res = await fetch(`${API_BASE}/auth/resend-otp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mobile }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Could not resend OTP");
  return data;
}

function loadStoredAuth() {
  try {
    const raw = sessionStorage.getItem(AUTH_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function useAuth() {
  const [authUser, setAuthUser] = useState(() => loadStoredAuth());
  const [phase, setPhase] = useState("details"); // "details" (mobile entry) | "otp"
  const [mobile, setMobile] = useState("");
  const [otp, setOtp] = useState("");
  const [submitting, setSubmitting] = useState(false); // covers the mobile step (may or may not need OTP)
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState("");
  const [resendCooldown, setResendCooldown] = useState(0);

  useEffect(() => {
    if (resendCooldown <= 0) return;
    const t = setInterval(() => setResendCooldown((c) => Math.max(0, c - 1)), 1000);
    return () => clearInterval(t);
  }, [resendCooldown]);

  const updateName = useCallback((newName) => {
    setAuthUser((prev) => {
      if (!prev) return prev;
      const updated = { ...prev, user: { ...prev.user, name: newName } };
      sessionStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(updated));
      return updated;
    });
  }, []);

  const validateMobile = useCallback(() => {
    if (!/^[6-9]\d{9}$/.test(mobile.trim())) return "Enter a valid 10-digit mobile number";
    return "";
  }, [mobile]);

  const persistAuth = useCallback((token, user) => {
    const authData = { token, user, mobile: user.mobile };
    setAuthUser(authData);
    sessionStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(authData));
  }, []);

  // Submitting mobile number — backend decides: known + verified number → log
  // in directly, new number → move to OTP phase.
  const submitDetails = useCallback(async () => {
    const validationError = validateMobile();
    if (validationError) {
      setError(validationError);
      return;
    }
    setError("");
    setSubmitting(true);
    try {
      const result = await apiLoginOrRegister(mobile.trim());

      if (result.status === "logged_in") {
        persistAuth(result.token, result.user);
      } else if (result.status === "otp_sent") {
        setPhase("otp");
        setResendCooldown(30);
      } else {
        setError("Unexpected response. Try again.");
      }
    } catch (err) {
      setError(err.message || "Something went wrong. Try again.");
    } finally {
      setSubmitting(false);
    }
  }, [mobile, validateMobile, persistAuth]);

  const resendOtp = useCallback(async () => {
    if (resendCooldown > 0) return;
    setError("");
    setSubmitting(true);
    try {
      await apiResendOtp(mobile.trim());
      setResendCooldown(30);
    } catch (err) {
      setError(err.message || "Could not resend OTP. Try again.");
    } finally {
      setSubmitting(false);
    }
  }, [mobile, resendCooldown]);

  const verifyOtp = useCallback(async () => {
    if (!otp.trim()) {
      setError("Enter the OTP");
      return;
    }
    setError("");
    setVerifying(true);
    try {
      const { token, user } = await apiVerifyOtp(mobile.trim(), otp.trim());
      persistAuth(token, user);
    } catch (err) {
      setError(err.message || "Invalid OTP. Try again.");
    } finally {
      setVerifying(false);
    }
  }, [otp, mobile, persistAuth]);

  const changeNumber = useCallback(() => {
    setPhase("details");
    setOtp("");
    setError("");
  }, []);

  const logout = useCallback(() => {
    setAuthUser(null);
    setPhase("details");
    setMobile("");
    setOtp("");
    sessionStorage.removeItem(AUTH_STORAGE_KEY);
  }, []);

  return {
    isAuthenticated: !!authUser,
    authUser,
    phase,
    mobile, setMobile,
    otp, setOtp,
    submitting,
    verifying,
    error,
    resendCooldown,
    submitDetails,
    resendOtp,
    verifyOtp,
    changeNumber,
    logout,
    updateName,
  };
}