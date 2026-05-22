"use client";

export default function DriftBadge({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span className="inline-flex items-center justify-center rounded-full bg-red-600 text-white text-xs font-bold min-w-[20px] h-5 px-1.5 leading-none">
      {count > 99 ? "99+" : count}
    </span>
  );
}
