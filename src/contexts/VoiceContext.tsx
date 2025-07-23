'use client';

import React, { createContext, useContext, useState, useEffect } from 'react';

interface VoiceContextType {
  voiceId: string | null;
  isLoading: boolean;
  error: string | null;
}

const VoiceContext = createContext<VoiceContextType | undefined>(undefined);

export function VoiceProvider({ children }: { children: React.ReactNode }) {
  const [voiceId, setVoiceId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchVoiceId = async () => {
      try {
        const response = await fetch('/api/voice');
        if (!response.ok) {
          throw new Error(`Failed to fetch voice: ${response.statusText}`);
        }
        const data = await response.json();
        setVoiceId(data.voice_id);
      } catch (err) {
        console.error('Error fetching voice ID:', err);
        setError(err instanceof Error ? err.message : 'Failed to load voice configuration');
      } finally {
        setIsLoading(false);
      }
    };

    fetchVoiceId();
  }, []);

  return (
    <VoiceContext.Provider value={{ voiceId, isLoading, error }}>
      {children}
    </VoiceContext.Provider>
  );
}

export function useVoice() {
  const context = useContext(VoiceContext);
  if (context === undefined) {
    throw new Error('useVoice must be used within a VoiceProvider');
  }
  return context;
}