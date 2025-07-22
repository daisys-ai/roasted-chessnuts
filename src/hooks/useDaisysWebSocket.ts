import { useEffect, useRef, useState, useCallback } from 'react';

// Global counter that persists across reconnections
let globalRequestCounter = 1;

interface ChunkData {
  prefix: any;
  audio: ArrayBuffer;
  globalId: number;
}

class ChunkOrderer {
  private chunks: Map<string, ChunkData> = new Map();
  private nextGlobalId = 1;
  private audioPlayer: any;
  private completedRequests: Set<number> = new Set();

  constructor(audioPlayer: any) {
    this.audioPlayer = audioPlayer;
  }

  addChunk(prefix: any, audio: ArrayBuffer, globalId: number) {
    // Create a unique key based on globalId, part_id, and chunk_id
    const partId = prefix.part_id ?? 0;
    const chunkId = prefix.chunk_id ?? 0;
    const key = `${globalId}-${partId}-${chunkId}`;
    
    this.chunks.set(key, { prefix, audio, globalId });
    // Reduced logging - only log first chunk
    if (this.chunks.size === 1) {
      console.log(`ChunkOrderer: Started receiving audio chunks`);
    }
    
    // Try to process chunks in order
    this.processChunks();
  }

  markRequestComplete(globalId: number) {
    this.completedRequests.add(globalId);
    this.processChunks();
  }

  private processChunks() {
    let processed = true;
    
    while (processed) {
      processed = false;
      
      // Process all chunks for the current globalId
      const currentChunks = Array.from(this.chunks.entries())
        .filter(([key, data]) => data.globalId === this.nextGlobalId)
        .sort((a, b) => {
          const [aGlobal, aPart, aChunk] = a[0].split('-').map(Number);
          const [bGlobal, bPart, bChunk] = b[0].split('-').map(Number);
          if (aPart !== bPart) return aPart - bPart;
          return aChunk - bChunk;
        });
      
      // Process all chunks for current globalId
      for (const [key, chunkData] of currentChunks) {
        this.audioPlayer.playAudio(chunkData.prefix, chunkData.audio);
        this.chunks.delete(key);
        processed = true;
      }
      
      // If we processed chunks and this request is complete, wait before moving to next
      if (processed && this.completedRequests.has(this.nextGlobalId)) {
        this.completedRequests.delete(this.nextGlobalId);
        
        // Calculate approximate duration based on ChunkAudioPlayer's buffer
        const estimatedDuration = this.audioPlayer.buffer ? 
          (this.audioPlayer.buffer.length / (this.audioPlayer.audioContext?.sampleRate || 44100)) * 1000 : 
          2000;
        
        // Wait for audio to finish playing plus a half second gap
        setTimeout(() => {
          this.nextGlobalId++;
          this.processChunks(); // Process next batch
        }, estimatedDuration + 500); // Add 500ms (0.5 second) gap between messages
        
        break; // Exit the while loop, we'll continue after timeout
      } else if (!processed && this.completedRequests.has(this.nextGlobalId)) {
        // No chunks but request is complete, skip to next
        this.completedRequests.delete(this.nextGlobalId);
        this.nextGlobalId++;
        processed = true;
      }
    }
    
    // Only log if we're waiting for chunks
    if (this.chunks.size > 0 || this.completedRequests.size > 0) {
      console.log(`ChunkOrderer: Buffering audio...`);
    }
  }

  reset() {
    this.chunks.clear();
    this.completedRequests.clear();
    this.nextGlobalId = 1;
  }
}

export function useDaisysWebSocket() {
  const [isConnected, setIsConnected] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const wsRef = useRef<any>(null);
  const audioPlayerRef = useRef<any>(null);
  const chunkOrdererRef = useRef<ChunkOrderer | null>(null);
  const activeRequestsRef = useRef<Set<number>>(new Set());
  const onAudioStartRef = useRef<(() => void) | null>(null);
  const onAudioEndRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    // Dynamically import Daisys modules
    const initWebSocket = async () => {
      try {
        const { WebsocketStream } = await import('@/lib/daisys_ws/websocket_stream');
        const { ChunkAudioPlayer } = await import('@/lib/daisys_ws/chunk_audio_player');
        
        // Create a single audio player instance
        audioPlayerRef.current = new ChunkAudioPlayer();
        
        // Create the chunk orderer
        chunkOrdererRef.current = new ChunkOrderer(audioPlayerRef.current);
        
        // Create WebSocket stream with proper options
        const ws = new WebsocketStream(
          '/api/websocket-url-text',
          {
            onconnectionstatus: (status: string) => {
              setIsConnected(status.toLowerCase().includes('connected'));
            }
          }
        );
        
        wsRef.current = ws;
        
      } catch (error) {
        console.error('Failed to initialize WebSocket:', error);
      }
    };

    initWebSocket();

    return () => {
      // Safely disconnect WebSocket
      try {
        if (wsRef.current && wsRef.current.close && typeof wsRef.current.close === 'function') {
          wsRef.current.close();
        } else if (wsRef.current && wsRef.current.connector && typeof wsRef.current.connector.disconnect === 'function') {
          wsRef.current.connector.disconnect();
        }
      } catch (error) {
        console.error('Error disconnecting WebSocket:', error);
      }
      
      // Clean up audio player
      try {
        if (audioPlayerRef.current && audioPlayerRef.current.endStream && typeof audioPlayerRef.current.endStream === 'function') {
          audioPlayerRef.current.endStream();
        }
      } catch (error) {
        console.error('Error ending audio stream:', error);
      }
    };
  }, []);

  const playText = useCallback(async (text: string, onStart?: () => void, onEnd?: () => void) => {
    if (!wsRef.current || !isConnected || !chunkOrdererRef.current) {
      console.error('WebSocket not ready - please wait for connection');
      return;
    }
    
    // Store callbacks for this request
    if (onStart) onAudioStartRef.current = onStart;
    if (onEnd) onAudioEndRef.current = onEnd;

    // Use global counter for request ID
    const requestId = globalRequestCounter++;
    const globalId = requestId; // Use request ID as global ID
    activeRequestsRef.current.add(globalId);
    
    try {
      // Get voice ID from backend if not cached
      let voiceId = wsRef.current.voiceId;
      if (!voiceId) {
        const response = await fetch('/api/websocket-url', { method: 'POST' });
        const data = await response.json();
        voiceId = data.voice_id;
        wsRef.current.voiceId = voiceId;
      }
      
      // Create TTS request in Daisys format
      const message = {
        command: '/take/generate',
        request_id: requestId,
        data: {
          text: text,
          voice_id: voiceId
        },
        stream: { mode: 'chunks' }
      };
      
      // Don't log the request, wait for first chunk
      
      // Get message stream
      const messageStream = wsRef.current.messageStream(message);
      
      setIsPlaying(true);
      
      try {
        let firstChunk = true;
        // Process the stream
        for await (const [info, prefix, audio] of messageStream) {
          // Handle status messages
          if (info) {
            if (info.data?.status === 'error') {
              console.error(`TTS Error:`, info.data);
              break;
            }
          }
          // Handle audio chunks
          else if (prefix && audio) {
            // Call onStart callback on first chunk
            if (firstChunk && onAudioStartRef.current) {
              console.log('First audio chunk received, calling onStart');
              onAudioStartRef.current();
              onAudioStartRef.current = null; // Clear after calling
              firstChunk = false;
            }
            
            // Add chunk to orderer
            chunkOrdererRef.current.addChunk(prefix, audio, globalId);
          }
        }
        
        // Stream complete
        
      } catch (error) {
        console.error(`[global_${globalId}] Error processing stream:`, error);
      }
      
      // Mark this request as complete in the orderer
      chunkOrdererRef.current.markRequestComplete(globalId);
      
      // Remove this request from active set
      activeRequestsRef.current.delete(globalId);
      
      // If no more active requests, we're done playing
      if (activeRequestsRef.current.size === 0) {
        // Calculate duration and call onEnd callback
        const audioPlayer = audioPlayerRef.current;
        const estimatedDuration = audioPlayer?.buffer ? 
          (audioPlayer.buffer.length / (audioPlayer.audioContext?.sampleRate || 44100)) * 1000 : 
          2000;
        
        setTimeout(() => {
          if (activeRequestsRef.current.size === 0) {
            setIsPlaying(false);
            // Call onEnd callback when audio finishes
            if (onAudioEndRef.current) {
              console.log('Audio playback complete, calling onEnd');
              onAudioEndRef.current();
              onAudioEndRef.current = null;
            }
          }
        }, estimatedDuration + 500); // Add buffer time
      }
      
    } catch (error) {
      console.error(`[global_${globalId}] Error playing text:`, error);
      activeRequestsRef.current.delete(globalId);
      if (activeRequestsRef.current.size === 0) {
        setIsPlaying(false);
      }
    }
  }, [isConnected]);

  const stop = useCallback(() => {
    // Clear active requests
    activeRequestsRef.current.clear();
    
    // Reset chunk orderer
    if (chunkOrdererRef.current) {
      chunkOrdererRef.current.reset();
    }
    
    // Stop the audio player
    if (audioPlayerRef.current) {
      audioPlayerRef.current.endStream();
    }
    
    setIsPlaying(false);
  }, []);

  return {
    isConnected,
    isPlaying,
    playText,
    stop
  };
}