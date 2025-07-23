'use client';

import { useState, useEffect, useRef } from 'react';
import { Chess } from 'chess.js';
import axios from 'axios';
import { useDaisysWebSocket } from '@/hooks/useDaisysWebSocket';

interface Commentary {
  commentary: string;
  audioUrl?: string;
  audioUrls?: string[];  // Multiple audio URLs for sentence-by-sentence playback
  commentId?: string;  // ID for saved WebSocket audio chunks
}

// Feature flag for WebSocket audio
const USE_WEBSOCKET_AUDIO = true; // Set to true to enable WebSocket streaming
const USE_STREAMING_COMMENTARY = true; // Enable sentence-by-sentence streaming

export default function ChessGame() {
  const [Chessboard, setChessboard] = useState<any>(null);
  const [game, setGame] = useState(() => new Chess());
  const [moveHistory, setMoveHistory] = useState<string[]>([]);
  const [commentary, setCommentary] = useState<Commentary[]>([]);
  const [isThinking, setIsThinking] = useState(false);
  const isThinkingRef = useRef(false);
  const [gameMode, setGameMode] = useState<'vs-computer' | 'vs-human'>('vs-computer');
  const gameRef = useRef(game); // Keep a ref to prevent stale closures
  const audioQueueRef = useRef<string[]>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const hasPlayedRef = useRef<Set<string>>(new Set());
  const [wsStatus, setWsStatus] = useState('');
  const [audioBlocked, setAudioBlocked] = useState(false);
  const pendingCommentaryRef = useRef<Commentary | null>(null);

  // WebSocket audio hook (only used if enabled)
  const wsAudio = USE_WEBSOCKET_AUDIO ? useDaisysWebSocket() : null;
  
  useEffect(() => {
    if (wsAudio) {
      setWsStatus(wsAudio.isConnected ? '✅ Connected' : '🔌 Connecting...');
    }
  }, [wsAudio?.isConnected]);

  useEffect(() => {
    import('react-chessboard').then((mod) => {
      console.log('Loaded react-chessboard in main game:', mod);
      setChessboard(() => mod.Chessboard);
    });
  }, []);

  // Keep gameRef in sync with game state
  useEffect(() => {
    gameRef.current = game;
  }, [game]);

  useEffect(() => {
    const audio = new Audio();
    audioRef.current = audio;
    
    audio.addEventListener('ended', () => {
      playNextAudio();
    });

    return () => {
      audio.removeEventListener('ended', () => {});
    };
  }, []);

  const playNextAudio = async () => {
    if (audioQueueRef.current.length > 0 && audioRef.current) {
      const nextUrl = audioQueueRef.current.shift();
      if (nextUrl) {
        console.log('Attempting to play audio from:', nextUrl);
        try {
          audioRef.current.src = nextUrl;
          await audioRef.current.play();
          setIsPlaying(true);
        } catch (error: any) {
          console.error('Error playing audio:', error);
          // If it's a NotAllowedError, we need user interaction
          if (error.name === 'NotAllowedError') {
            console.log('Audio playback requires user interaction');
            // Put the URL back in the queue
            audioQueueRef.current.unshift(nextUrl);
            setIsPlaying(false);
            setAudioBlocked(true);
          } else {
            // Try next audio if this one fails
            playNextAudio();
          }
        }
      }
    } else {
      setIsPlaying(false);
    }
  };

  const addAudioToQueue = (url: string) => {
    audioQueueRef.current.push(url);
    if (!isPlaying) {
      playNextAudio();
    }
  };

  const playAudioManually = async (comment: Commentary) => {
    console.log('Manual play audio:', comment);
    if (audioRef.current) {
      try {
        // Stop current audio if playing
        if (!audioRef.current.paused) {
          audioRef.current.pause();
        }
        // Clear the queue
        audioQueueRef.current = [];
        
        if (comment.audioUrls && comment.audioUrls.length > 0) {
          // Add all URLs to queue
          comment.audioUrls.forEach(url => audioQueueRef.current.push(url));
          playNextAudio();
        } else if (comment.audioUrl) {
          // Play single URL
          audioRef.current.src = comment.audioUrl;
          await audioRef.current.play();
          setIsPlaying(true);
        }
      } catch (error) {
        console.error('Error playing audio manually:', error);
      }
    }
  };

  const sendMoveToBackend = async (move: string, player: 'human' | 'computer') => {
    try {
      // Send move to backend
      
      // Try streaming if enabled, even if WebSocket isn't ready yet
      if (USE_STREAMING_COMMENTARY) {
        // Use streaming endpoint for sentence-by-sentence generation
        try {
          const response = await fetch('/api/move-stream', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              fen: game.fen(),
              move: move,
              player: player,
              moveHistory: moveHistory
            })
          });
        
          if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
          }
          
          const reader = response.body?.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          let fullCommentary = '';
          let sentences: string[] = [];
          let commentaryStarted = false;
          
          if (reader) {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              
              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split('\n');
              buffer = lines.pop() || '';
              
              for (const line of lines) {
                if (line.startsWith('data: ')) {
                  try {
                    const data = JSON.parse(line.slice(6));
                    
                    if (data.type === 'sentence') {
                      sentences.push(data.text);
                      
                      // Update UI progressively
                      fullCommentary = sentences.join(' ');
                      const newCommentary: Commentary = {
                        commentary: fullCommentary,
                        audioUrls: [] // No URLs needed with WebSocket
                      };
                      
                      // Store commentary but don't display yet
                      if (!commentaryStarted) {
                        pendingCommentaryRef.current = newCommentary;
                        commentaryStarted = true;
                        console.log('Receiving commentary (waiting for audio)...', newCommentary);
                      } else {
                        pendingCommentaryRef.current = newCommentary;
                      }
                    } else if (data.type === 'complete') {
                      fullCommentary = data.full_commentary || fullCommentary;
                      // Send the complete commentary to TTS at once
                      if (USE_WEBSOCKET_AUDIO && wsAudio?.isConnected && fullCommentary) {
                        console.log('Speaking commentary...');
                        
                        // Set up callbacks based on player type
                        const onAudioStart = () => {
                          // Show commentary when audio starts
                          if (pendingCommentaryRef.current) {
                            const commentary = pendingCommentaryRef.current;
                            pendingCommentaryRef.current = null;
                            setCommentary(prev => [commentary, ...prev]);
                          } else {
                            console.error('No pending commentary to display on audio start');
                          }
                        };
                        
                        const onAudioEnd = player === 'human' && (window as any).__audioEndHandler ? 
                          (window as any).__audioEndHandler : null;
                        
                        wsAudio.playText(fullCommentary, onAudioStart, onAudioEnd).then(commentId => {
                          if (commentId) {
                            // Update the commentary with the comment ID
                            setCommentary(prev => {
                              const updated = [...prev];
                              const index = updated.findIndex(c => c.commentary === fullCommentary);
                              if (index !== -1) {
                                updated[index] = {
                                  ...updated[index],
                                  commentId: commentId
                                };
                              }
                              return updated;
                            });
                          }
                        });
                      }
                    } else if (data.type === 'error') {
                      console.error('Streaming error:', data.message);
                      throw new Error(data.message);
                    }
                  } catch (e) {
                    console.error('Error parsing SSE data:', e);
                  }
                }
              }
            }
          }
          
          return true;
        } catch (error) {
          console.error('Error in streaming:', error);
          // Fall back to regular endpoint
          console.log('Falling back to regular endpoint');
        }
      }
      
      // Regular endpoint (fallback or when streaming not available)
      const response = await axios.post('/api/move', {
        fen: game.fen(),
        move: move,
        player: player,
        moveHistory: moveHistory
      }, {
        timeout: 30000  // Increase timeout to 30 seconds
      });

      const newCommentary: Commentary = response.data;
      console.log('Received commentary:', newCommentary);
      
      // For non-streaming, show immediately
      if (!USE_WEBSOCKET_AUDIO) {
        setCommentary(prev => [newCommentary, ...prev]);
      } else {
        // Store pending and wait for audio
        pendingCommentaryRef.current = newCommentary;
        
        // Send to TTS with callbacks
        if (wsAudio?.isConnected) {
          const onAudioStart = () => {
            if (pendingCommentaryRef.current) {
              const commentary = pendingCommentaryRef.current;
              pendingCommentaryRef.current = null;
              setCommentary(prev => [commentary, ...prev]);
            }
          };
          
          const onAudioEnd = player === 'human' && (window as any).__audioEndHandler ? 
            (window as any).__audioEndHandler : null;
          
          if (newCommentary && newCommentary.commentary) {
            wsAudio.playText(newCommentary.commentary, onAudioStart, onAudioEnd).then(commentId => {
              if (commentId) {
                // Update the commentary with the comment ID
                setCommentary(prev => {
                  const updated = [...prev];
                  const index = updated.findIndex(c => c.commentary === newCommentary.commentary);
                  if (index !== -1) {
                    updated[index] = {
                      ...updated[index],
                      commentId: commentId
                    };
                  }
                  return updated;
                });
              }
            });
          } else {
            console.error('Invalid commentary response:', newCommentary);
            // Still show the commentary even if TTS fails
            if (newCommentary) {
              setCommentary(prev => [newCommentary, ...prev]);
            }
          }
        }
      }
      
      if (newCommentary.audioUrls && newCommentary.audioUrls.length > 0) {
        // Play multiple audio URLs in sequence
        newCommentary.audioUrls.forEach((url, index) => {
          if (!hasPlayedRef.current.has(url)) {
            hasPlayedRef.current.add(url);
            addAudioToQueue(url);
          }
        });
      } else if (newCommentary.audioUrl && !hasPlayedRef.current.has(newCommentary.audioUrl)) {
        // Use single audio URL
        hasPlayedRef.current.add(newCommentary.audioUrl);
        addAudioToQueue(newCommentary.audioUrl);
      }
      
      return true;
    } catch (error: any) {
      console.error('Error getting commentary:', error);
      console.error('Error details:', error.response?.data || error.message);
      return false;
    }
  };

  const makeComputerMove = () => {
    // Always use the latest game state from ref
    const currentGame = gameRef.current;
    const possibleMoves = currentGame.moves();
    if (possibleMoves.length === 0) return;

    const randomIndex = Math.floor(Math.random() * possibleMoves.length);
    const move = possibleMoves[randomIndex];
    
    const gameCopy = new Chess(currentGame.fen());
    const result = gameCopy.move(move);
    if (result) {
      setGame(gameCopy);
      setMoveHistory(prev => [...prev, move]);
      
      // For computer moves, send and let the callbacks handle display
      sendMoveToBackend(move, 'computer');
    }
  };

  function onDrop(sourceSquare: string, targetSquare: string, piece?: string) {
    // Removed verbose logging
    
    // This is a user interaction, so we can now safely play audio
    if (audioBlocked) {
      setAudioBlocked(false);
      if (audioRef.current && audioRef.current.paused && audioQueueRef.current.length > 0) {
        console.log('User interaction detected, attempting to play queued audio');
        playNextAudio();
      }
    }
    
    if (isThinking || isThinkingRef.current) {
      console.log('Blocked: Computer is thinking');
      return false;
    }
    
    // Check if WebSocket is connected before allowing moves
    if (USE_WEBSOCKET_AUDIO && (!wsAudio || !wsAudio.isConnected)) {
      console.log('Waiting for audio connection...');
      return false;
    }

    try {
      const gameCopy = new Chess(game.fen());
      const move = gameCopy.move({
        from: sourceSquare,
        to: targetSquare,
        promotion: 'q',
      });

      // Move validation

      if (move === null) {
        console.log('Invalid move');
        return false;
      }

      // Move accepted
      
      setGame(gameCopy);
      setMoveHistory(prev => [...prev, move.san]);
      
      // Send move to backend and wait for commentary before computer moves
      if (!gameCopy.isGameOver() && gameMode === 'vs-computer') {
        setIsThinking(true);
        isThinkingRef.current = true;
        console.log('Set thinking to true');
        
        // Send the move for commentary
        sendMoveToBackend(move.san, 'human');
        
        // Wait for audio to complete before computer moves
        if (USE_WEBSOCKET_AUDIO && wsAudio) {
          console.log('Human move sent, will wait for audio to complete');
          
          // Set up a callback for when audio ends
          // This will be triggered from the streaming complete handler
          const audioEndHandler = () => {
            console.log('Human move audio complete, computer will move in 1s');
            setTimeout(() => {
              if (isThinkingRef.current) {
                makeComputerMove();
                setIsThinking(false);
                isThinkingRef.current = false;
              }
            }, 1000);
          };
          
          // Store the handler to be called from the streaming complete event
          // We'll trigger this from the TTS playback completion
          (window as any).__audioEndHandler = audioEndHandler;
          
          // Safety timeout after 30 seconds
          setTimeout(() => {
            if (isThinkingRef.current) {
              console.log('Safety timeout reached');
              makeComputerMove();
              setIsThinking(false);
              isThinkingRef.current = false;
            }
          }, 30000);
        } else {
          // No WebSocket audio, use standard delay
          setTimeout(() => {
            makeComputerMove();
            setIsThinking(false);
            isThinkingRef.current = false;
          }, 2000);
        }
      } else {
        // Game is over, just send the final move
        sendMoveToBackend(move.san, 'human');
      }

      return true;
    } catch (error) {
      console.error('Error in onDrop:', error);
      return false;
    }
  }

  const resetGame = () => {
    console.log('Resetting game');
    const newGame = new Chess();
    setGame(newGame);
    setMoveHistory([]);
    setCommentary([]);
    setIsThinking(false);
    isThinkingRef.current = false;
    pendingCommentaryRef.current = null;
    audioQueueRef.current = [];
    hasPlayedRef.current.clear();
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = '';
    }
    setIsPlaying(false);
    
    // Clear saved WebSocket audio chunks
    if (USE_WEBSOCKET_AUDIO && wsAudio) {
      wsAudio.stop(); // This will reset the chunk orderer which clears saved chunks
    }
  };

  if (!Chessboard) {
    return <div className="bg-amber-100 p-6 rounded-lg shadow-2xl">Loading chess game...</div>;
  }

  return (
    <div className="flex flex-col lg:flex-row gap-4 p-4 w-full max-w-6xl mx-auto">
      {/* Chess Board */}
      <div className="w-full lg:w-1/2 flex items-start justify-center lg:justify-end">
        <div className="w-full max-w-[90vw] sm:max-w-[500px] bg-amber-100 p-4 rounded-lg shadow-2xl">
          <div className="bg-amber-50 p-2 rounded-lg">
            <Chessboard 
              id="RoastedChessnutsBoard"
              position={game.fen()} 
              onPieceDrop={onDrop}
              arePiecesDraggable={!isThinking && (!USE_WEBSOCKET_AUDIO || wsAudio?.isConnected)}
              customBoardStyle={{
                borderRadius: '8px',
                boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)',
              }}
            />
          </div>
        
        
          <div className="mt-4 flex flex-col sm:flex-row justify-center items-center gap-2">
            <button 
              onClick={(e) => {
                console.log('New Game button clicked');
                e.preventDefault();
                resetGame();
              }}
              className="px-4 py-2 bg-amber-700 text-white rounded-lg hover:bg-amber-800 transition-colors font-semibold shadow-lg cursor-pointer text-sm"
            >
              New Game
            </button>
            {isThinking && (
              <div className="px-4 py-2 text-amber-700 font-semibold flex items-center gap-2 text-sm">
                <div className="animate-spin h-3 w-3 border-2 border-amber-700 border-t-transparent rounded-full"></div>
                Computer thinking...
              </div>
            )}
            {audioBlocked && (
              <div className="px-4 py-2 text-amber-600 font-semibold animate-pulse text-sm">
                🔇 Make a move to enable audio
              </div>
            )}
            {USE_WEBSOCKET_AUDIO && !wsAudio?.isConnected && (
              <div className="px-4 py-2 text-amber-600 font-semibold animate-pulse text-sm">
                🔌 Connecting audio...
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Commentary Panel */}
      <div className="w-full lg:w-1/2 flex items-start justify-center lg:justify-start">
        <div className="w-full max-w-[90vw] sm:max-w-[500px] bg-amber-100 p-4 rounded-lg shadow-2xl">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-xl font-bold text-amber-900">Commentary</h2>
            {USE_WEBSOCKET_AUDIO && (
              <span className="text-xs text-amber-700">
                WebSocket: {wsStatus}
              </span>
            )}
          </div>
          <div className="h-[400px] sm:h-[500px] lg:h-[600px] overflow-y-auto space-y-3">
            {commentary.length === 0 ? (
              <p className="text-amber-700 italic p-4 text-sm">
                {USE_WEBSOCKET_AUDIO && !wsAudio?.isConnected 
                  ? 'Waiting for audio connection...'
                  : 'Make a move to hear the roast...'}
              </p>
            ) : (
              <div className="space-y-3">
                {commentary.map((comment, index) => (
                  <div 
                    key={`${index}-${comment.commentary.substring(0, 10)}`} 
                    className={`p-3 bg-amber-50 rounded-lg border-2 border-amber-300 transition-all duration-500 ease-out flex items-center justify-between gap-2 ${
                      index === 0 ? 'animate-slide-in' : ''
                    }`}
                    style={{
                      opacity: index === 0 ? 0 : 1,
                      animation: index === 0 ? 'slideIn 0.5s ease-out forwards' : 'none'
                    }}
                  >
                    <p className="text-amber-900 italic text-sm flex-1">{comment.commentary}</p>
                    {USE_WEBSOCKET_AUDIO && wsAudio ? (
                      <button 
                        onClick={() => {
                          if (comment.commentId && wsAudio.hasSavedAudio(comment.commentId)) {
                            wsAudio.playSavedAudio(comment.commentId);
                          } else if (wsAudio.isConnected) {
                            wsAudio.playText(comment.commentary);
                          }
                        }}
                        className="text-amber-600 hover:text-amber-800 transition-colors flex-shrink-0"
                        aria-label="Play audio"
                      >
                        🔊
                      </button>
                    ) : (comment.audioUrl || comment.audioUrls) && (
                      <button 
                        onClick={() => playAudioManually(comment)}
                        className="text-amber-600 hover:text-amber-800 transition-colors flex-shrink-0"
                        aria-label="Play audio"
                      >
                        🔊
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
          {/* Daisys Voice Attribution */}
          <div className="mt-3 flex items-center justify-center gap-2 text-xs text-amber-700">
            <span>Voices by</span>
            <img 
              src="/static/daisys-logo-vid.svg" 
              alt="Daisys" 
              className="h-4 w-auto"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
