"use client";

/**
 * Client-side holder for the operator token that authorizes control-plane
 * commands (kill / resume / operator actions). The token is entered by the
 * operator in the UI, kept in sessionStorage (per-tab, cleared on close) with an
 * in-memory fallback when storage is unavailable, and attached by the command
 * clients as an `Authorization: Bearer` header. Never read during render —
 * consumers load it inside effects/handlers, so SSR/hydration never sees it.
 */

const STORAGE_KEY = "nexus.operator.token";

let memoryToken = "";

export function getOperatorToken(): string {
  try {
    return window.sessionStorage.getItem(STORAGE_KEY) ?? memoryToken;
  } catch {
    return memoryToken;
  }
}

export function setOperatorToken(token: string): void {
  memoryToken = token;
  try {
    if (token === "") window.sessionStorage.removeItem(STORAGE_KEY);
    else window.sessionStorage.setItem(STORAGE_KEY, token);
  } catch {
    // sessionStorage unavailable (private mode / storage policy) — the
    // in-memory fallback above still holds the token for this page lifetime.
  }
}
