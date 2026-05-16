import Chat from "./components/Chat";

export default function Home() {
  return (
    <main className="min-h-screen bg-gray-950 text-gray-100 flex flex-col">
      <header className="border-b border-gray-800 px-6 py-4">
        <h1 className="text-lg font-semibold tracking-tight">
          purpl<span className="text-purple-400">_brain</span>
        </h1>
      </header>
      <Chat />
    </main>
  );
}
