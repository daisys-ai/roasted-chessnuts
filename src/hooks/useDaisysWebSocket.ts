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
  private savedChunks: Map<string, Array<{prefix: any, audio: ArrayBuffer}>> = new Map(); // Store chunks by comment ID

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
        
        // Save chunk for replay
        const commentId = `comment-${chunkData.globalId}`;
        if (!this.savedChunks.has(commentId)) {
          this.savedChunks.set(commentId, []);
        }
        this.savedChunks.get(commentId)!.push({
          prefix: chunkData.prefix,
          audio: chunkData.audio
        });
        
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
    this.savedChunks.clear();
  }

  playSavedChunks(commentId: string) {
    const chunks = this.savedChunks.get(commentId);
    if (!chunks || chunks.length === 0) {
      console.log(`No saved chunks found for ${commentId}`);
      return;
    }
    
    console.log(`Playing ${chunks.length} saved chunks for ${commentId}`);
    
    // Group chunks by part_id to ensure proper ordering
    const partGroups = new Map<number, Array<{prefix: any, audio: ArrayBuffer}>>();
    
    for (const chunk of chunks) {
      const partId = chunk.prefix.part_id ?? 0;
      if (!partGroups.has(partId)) {
        partGroups.set(partId, []);
      }
      partGroups.get(partId)!.push(chunk);
    }
    
    // Sort parts by part_id
    const sortedParts = Array.from(partGroups.entries()).sort((a, b) => a[0] - b[0]);
    
    console.log(`Found ${sortedParts.length} parts to play`);
    
    // Play all chunks in correct order: by part, then by chunk within each part
    for (const [partId, partChunks] of sortedParts) {
      // Sort chunks within the part by chunk_id
      const sortedChunks = partChunks.sort((a, b) => {
        const aChunkId = a.prefix.chunk_id ?? 0;
        const bChunkId = b.prefix.chunk_id ?? 0;
        return aChunkId - bChunkId;
      });
      
      console.log(`Playing part ${partId} with ${sortedChunks.length} chunks`);
      
      // Play all chunks for this part
      for (const chunk of sortedChunks) {
        this.audioPlayer.playAudio(chunk.prefix, chunk.audio);
      }
    }
  }

  hasSavedChunks(commentId: string): boolean {
    return this.savedChunks.has(commentId) && this.savedChunks.get(commentId)!.length > 0;
  }
  
  getSavedChunks(commentId: string): Array<{prefix: any, audio: ArrayBuffer}> | undefined {
    return this.savedChunks.get(commentId);
  }
}

export function useDaisysWebSocket(voiceId: string) {
  const [isConnected, setIsConnected] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const wsRef = useRef<any>(null);
  const audioPlayerRef = useRef<any>(null);
  const chunkOrdererRef = useRef<ChunkOrderer | null>(null);
  const activeRequestsRef = useRef<Set<number>>(new Set());
  const onAudioStartRef = useRef<(() => void) | null>(null);
  const onAudioEndRef = useRef<(() => void) | null>(null);
  const voiceIdRef = useRef(voiceId);
  
  // Update ref when voiceId changes
  useEffect(() => {
    voiceIdRef.current = voiceId;
  }, [voiceId]);

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
              const isConnected = status.toLowerCase().includes('connected');
              setIsConnected(isConnected);
              
              if (!isConnected && status.toLowerCase().includes('error')) {
                console.error('WebSocket connection error:', status);
              }
            },
            onerror: (error: any) => {
              console.error('WebSocket error:', error);
              setIsConnected(false);
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

  const playText = useCallback(async (text: string, onStart?: () => void, onEnd?: () => void): Promise<string | null> => {
    if (!wsRef.current || !isConnected || !chunkOrdererRef.current) {
      console.error('WebSocket not ready - please wait for connection');
      return null;
    }
    
    // Store callbacks for this request
    if (onStart) onAudioStartRef.current = onStart;
    if (onEnd) onAudioEndRef.current = onEnd;

    // Use global counter for request ID
    const requestId = globalRequestCounter++;
    const globalId = requestId; // Use request ID as global ID
    const commentId = `comment-${globalId}`;
    activeRequestsRef.current.add(globalId);
    
    try {
      // Create TTS request in Daisys format using the voice ID from the ref
      const message = {
        command: '/take/generate',
        request_id: requestId,
        data: {
          text: text,
          voice_id: voiceIdRef.current
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
              console.error(`Daisys Error:`, info.data);
              
              // Still call onStart callback even if TTS fails
              // This ensures the commentary is displayed
              if (firstChunk && onAudioStartRef.current) {
                onAudioStartRef.current();
                onAudioStartRef.current = null;
                firstChunk = false;
              }
              
              // Since TTS failed, we should call onEnd immediately if it exists
              // This is important for human moves to ensure the computer moves next
              if (onAudioEndRef.current) {
                console.log('Calling onEnd immediately due to TTS error');
                onAudioEndRef.current();
                onAudioEndRef.current = null;
              }
              
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
    
    return commentId; // Return the comment ID for later reference
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

  const playSavedAudio = useCallback(async (commentId: string) => {
    if (!chunkOrdererRef.current) {
      console.error('Chunk orderer not ready');
      return;
    }
    
    try {
      // Import ChunkAudioPlayer dynamically
      const { ChunkAudioPlayer } = await import('@/lib/daisys_ws/chunk_audio_player');
      
      // Create a fresh audio player for replay
      const replayPlayer = new ChunkAudioPlayer();
      
      // Get the saved chunks
      const chunks = chunkOrdererRef.current.getSavedChunks(commentId);
      if (!chunks || chunks.length === 0) {
        console.log(`No saved chunks found for ${commentId}`);
        return;
      }
      
      console.log(`Playing ${chunks.length} saved chunks for ${commentId}`);
      
      // Play all chunks in order
      for (const chunk of chunks) {
        replayPlayer.playAudio(chunk.prefix, chunk.audio);
      }
      
      // Clean up when audio finishes (approximate duration)
      const duration = replayPlayer.buffer ? 
        (replayPlayer.buffer.length / (replayPlayer.audioContext?.sampleRate || 44100)) * 1000 : 
        5000;
      
      setTimeout(() => {
        if (replayPlayer.endStream) {
          replayPlayer.endStream();
        }
      }, duration + 1000);
      
    } catch (error) {
      console.error('Error playing saved audio:', error);
    }
  }, []);

  const hasSavedAudio = useCallback((commentId: string): boolean => {
    if (!chunkOrdererRef.current) return false;
    return chunkOrdererRef.current.hasSavedChunks(commentId);
  }, []);

  return {
    isConnected,
    isPlaying,
    playText,
    playSavedAudio,
    hasSavedAudio,
    stop
  };
}
