"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import UserMenu from "./UserMenu";
import LeftSidebar from "./LeftSidebar";
import Chat from "./Chat";

function MenuIcon() {
  return (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  );
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const segments = pathname.split("/").filter(Boolean);
  const projectId =
    segments[0] === "p" && segments[1] ? decodeURIComponent(segments[1]) : null;

  return (
    <div className="flex flex-col h-screen bg-gray-950 text-gray-100 overflow-hidden">
      <header className="border-b border-gray-800 px-4 py-3 flex items-center gap-3 shrink-0">
        <button
          onClick={() => setSidebarOpen((v) => !v)}
          className="hidden lg:block text-gray-500 hover:text-gray-300 transition-colors"
          aria-label="Toggle sidebar"
        >
          <MenuIcon />
        </button>
        <Link href="/" className="text-lg font-semibold tracking-tight shrink-0">
          purpl<span className="text-purple-400">_brain</span>
        </Link>
        <div className="ml-auto flex items-center gap-3">
          <UserMenu />
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <LeftSidebar open={sidebarOpen} currentProjectId={projectId} />

        <main className="flex-1 overflow-y-auto">
          {children}
        </main>

        <div className="hidden lg:flex w-[360px] shrink-0 border-l border-gray-800 flex-col overflow-hidden">
          <Chat projectId={projectId ?? undefined} />
        </div>
      </div>
    </div>
  );
}
