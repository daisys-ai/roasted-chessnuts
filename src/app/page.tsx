'use client';

import ChessGame from '@/components/ChessGame';

export default function Home() {
  return (
    <main className="min-h-screen relative">
      {/* Background image with blur */}
      <div 
        className="absolute inset-0 z-0"
        style={{
          backgroundImage: 'url(/static/chestnuts.jpg)',
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          backgroundRepeat: 'no-repeat',
          filter: 'blur(4px)',
        }}
      />
      {/* Gradient overlay */}
      <div className="absolute inset-0 z-10 bg-gradient-to-br from-amber-900/80 via-amber-800/80 to-amber-900/80" />
      
      {/* Content */}
      <div className="w-full relative z-20">
        <div className="flex items-center justify-between px-4 sm:px-8 py-4 sm:py-6 md:py-8">
          <div className="flex-1" />
          <h1 className="text-3xl sm:text-4xl md:text-5xl font-bold text-center text-amber-100 drop-shadow-lg">
            🔥 Roasted Chessnuts 🔥
          </h1>
          <div className="flex-1 flex justify-end items-center">
            <a 
              href="https://daisys.ai" 
              target="_blank" 
              rel="noopener noreferrer"
              className="flex items-center gap-2 text-amber-100/80 text-sm opacity-90 hover:opacity-100 transition-opacity"
            >
              <span className="hidden sm:inline">Voices by</span>
              <img 
                src="/static/daisys-logo-vid.svg" 
                alt="Daisys" 
                className="h-8 sm:h-10 w-auto"
              />
            </a>
          </div>
        </div>
        
        <ChessGame />
      </div>
    </main>
  );
}
