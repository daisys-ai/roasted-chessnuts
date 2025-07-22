'use client';

import ChessGame from '@/components/ChessGame';

export default function Home() {
  return (
    <main className="min-h-screen bg-gradient-to-br from-amber-900 via-amber-800 to-amber-900 p-8">
      <div className="max-w-7xl mx-auto">
        <h1 className="text-5xl font-bold text-center mb-8 text-amber-100 drop-shadow-lg">
          🔥 Roasted Chessnuts 🔥
        </h1>
        
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          <ChessGame />
        </div>
      </div>
    </main>
  );
}
