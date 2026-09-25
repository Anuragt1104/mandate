"use client";

import { useEffect, useState } from "react";
import { fetchSimBook } from "./chain";

/**
 * Names for the simulated participants on the test network (scripts/simulate.ts writes
 * them). Anything named here is fictional and is always shown with a "SIM" mark.
 */
export type PersonaRole = "launchpad" | "issuer" | "maker" | "trader" | "whale" | "attacker" | "watchtower";
export interface Persona {
  name: string;
  role: PersonaRole;
  bio: string;
}
export interface PersonaBook {
  note: string;
  parties: Record<string, Persona>;
  mandates: Record<string, string>;
}

const EMPTY: PersonaBook = { note: "", parties: {}, mandates: {} };
let cache: PersonaBook | null = null;
let pending: Promise<PersonaBook> | null = null;

export function loadPersonas(): Promise<PersonaBook> {
  if (cache) return Promise.resolve(cache);
  pending ??= fetchSimBook().then((b) => (cache = { ...EMPTY, ...b }));
  return pending;
}

export function usePersonas(): PersonaBook {
  const [book, setBook] = useState<PersonaBook>(cache ?? EMPTY);
  useEffect(() => {
    if (!cache) loadPersonas().then(setBook);
  }, []);
  return book;
}

export function personaOf(book: PersonaBook, address: { toBase58(): string } | string | null | undefined): Persona | null {
  if (!address) return null;
  return book.parties[typeof address === "string" ? address : address.toBase58()] ?? null;
}
