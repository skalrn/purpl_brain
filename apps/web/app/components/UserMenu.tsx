"use client";

import { useEffect, useState } from "react";

interface Me {
  person_id: string;
  name: string;
  github_login: string;
  avatar_url: string;
  api_key: string;
}

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
const API_KEY = process.env.NEXT_PUBLIC_API_KEY ?? "";

export default function UserMenu() {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${API_URL}/auth/me`, {
      credentials: "include",
      headers: { "x-api-key": API_KEY },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { setMe(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  if (loading) return null;

  if (!me) {
    return (
      <a
        href={`${API_URL}/auth/github`}
        className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-gray-800 hover:bg-gray-700 text-sm text-gray-300 transition-colors"
      >
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
        </svg>
        Login with GitHub
      </a>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <img
        src={me.avatar_url}
        alt={me.name}
        className="w-7 h-7 rounded-full"
      />
      <span className="text-sm text-gray-400">{me.github_login}</span>
      <button
        onClick={async () => {
          await fetch(`${API_URL}/auth/logout`, { method: "POST", credentials: "include" });
          setMe(null);
        }}
        className="text-xs text-gray-600 hover:text-gray-400 transition-colors"
      >
        logout
      </button>
    </div>
  );
}
