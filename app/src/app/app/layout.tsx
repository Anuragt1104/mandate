import type { Metadata } from "next";
import { AppNav } from "@/components/nav";

export const metadata: Metadata = { title: "App" };

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <AppNav />
      <main className="container app-main">{children}</main>
    </>
  );
}
