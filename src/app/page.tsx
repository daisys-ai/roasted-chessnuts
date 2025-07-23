'use client';

import ChessGame from '@/components/ChessGame';

export default function Home() {
  return (
    <main className="min-h-screen bg-gradient-to-br from-amber-900 via-amber-800 to-amber-900">
      <div className="w-full">
        <h1 className="text-3xl sm:text-4xl md:text-5xl font-bold text-center py-4 sm:py-6 md:py-8 text-amber-100 drop-shadow-lg">
          🔥 Roasted Chessnuts 🔥
        </h1>
        
        <ChessGame />
      </div>
    </main>
  );
}
