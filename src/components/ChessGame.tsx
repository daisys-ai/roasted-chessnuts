'use client';

import { useState, useEffect, useRef } from 'react';
import { Chess } from 'chess.js';
import axios from 'axios';

interface Commentary {
  commentary: string;
  audioUrl?: string;
}

export default function ChessGame() {
  const [Chessboard, setChessboard] = useState<any>(null);
  const [game, setGame] = useState(() => new Chess());
  const [moveHistory, setMoveHistory] = useState<string[]>([]);
  const [commentary, setCommentary] = useState<Commentary[]>([]);
  const [isThinking, setIsThinking] = useState(false);
  const audioQueueRef = useRef<string[]>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const hasPlayedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    import('react-chessboard').then((mod) => {
      console.log('Loaded react-chessboard in main game:', mod);
      setChessboard(() => mod.Chessboard);
    });
  }, []);

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
        } catch (error) {
          console.error('Error playing audio:', error);
          // Try next audio if this one fails
          playNextAudio();
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

  const playAudioManually = async (url: string) => {
    console.log('Manual play audio:', url);
    if (audioRef.current) {
      try {
        // Stop current audio if playing
        if (!audioRef.current.paused) {
          audioRef.current.pause();
        }
        // Clear the queue and play this audio immediately
        audioQueueRef.current = [];
        audioRef.current.src = url;
        await audioRef.current.play();
        setIsPlaying(true);
      } catch (error) {
        console.error('Error playing audio manually:', error);
      }
    }
  };

  const sendMoveToBackend = async (move: string, player: 'human' | 'computer') => {
    try {
      console.log('Sending move to backend:', move, player);
      const response = await axios.post('/api/move', {
        fen: game.fen(),
        move: move,
        player: player,
        moveHistory: moveHistory
      });

      const newCommentary: Commentary = response.data;
      console.log('Received commentary:', newCommentary);
      setCommentary(prev => [newCommentary, ...prev]);
      
      // Automatically play audio for new commentary
      if (newCommentary.audioUrl && !hasPlayedRef.current.has(newCommentary.audioUrl)) {
        console.log('Auto-playing new audio:', newCommentary.audioUrl);
        hasPlayedRef.current.add(newCommentary.audioUrl);
        addAudioToQueue(newCommentary.audioUrl);
      }
      
      return true; // Success
    } catch (error: any) {
      console.error('Error getting commentary:', error);
      console.error('Error details:', error.response?.data || error.message);
      return false; // Failed
    }
  };

  const makeComputerMove = (currentGame: Chess) => {
    const possibleMoves = currentGame.moves();
    if (possibleMoves.length === 0) return;

    const randomIndex = Math.floor(Math.random() * possibleMoves.length);
    const move = possibleMoves[randomIndex];
    
    const gameCopy = new Chess(currentGame.fen());
    const result = gameCopy.move(move);
    if (result) {
      setGame(gameCopy);
      setMoveHistory(prev => [...prev, move]);
      sendMoveToBackend(move, 'computer');
    }
  };

  function onDrop(sourceSquare: string, targetSquare: string, piece?: string) {
    console.log('onDrop called - params:', { sourceSquare, targetSquare, piece });
    console.log('Current FEN:', game.fen());
    console.log('Is thinking:', isThinking);
    
    if (isThinking) {
      console.log('Blocked: Computer is thinking');
      return false;
    }

    try {
      const gameCopy = new Chess(game.fen());
      const move = gameCopy.move({
        from: sourceSquare,
        to: targetSquare,
        promotion: 'q',
      });

      console.log('Move result:', move);

      if (move === null) {
        console.log('Invalid move');
        return false;
      }

      console.log('Valid move:', move.san);
      console.log('New FEN:', gameCopy.fen());
      
      setGame(gameCopy);
      setMoveHistory(prev => [...prev, move.san]);
      
      // Send move to backend and wait for commentary before computer moves
      if (!gameCopy.isGameOver()) {
        setIsThinking(true);
        sendMoveToBackend(move.san, 'human').then((success) => {
          if (success) {
            // Wait a bit after commentary is received before computer moves
            setTimeout(() => {
              makeComputerMove(gameCopy);
              setIsThinking(false);
            }, 1000);
          } else {
            // If commentary failed, still let computer move
            setTimeout(() => {
              makeComputerMove(gameCopy);
              setIsThinking(false);
            }, 500);
          }
        });
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
    audioQueueRef.current = [];
    hasPlayedRef.current.clear();
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = '';
    }
    setIsPlaying(false);
  };

  if (!Chessboard) {
    return <div className="bg-amber-100 p-6 rounded-lg shadow-2xl">Loading chess game...</div>;
  }

  return (
    <>
      <div className="bg-amber-100 p-4 rounded-lg shadow-2xl">
        <div className="w-full max-w-[600px] mx-auto bg-amber-50 p-2 rounded-lg">
          <Chessboard 
            id="RoastedChessnutsBoard"
            position={game.fen()} 
            onPieceDrop={onDrop}
            arePiecesDraggable={true}
            boardWidth={560}
            customBoardStyle={{
              borderRadius: '8px',
              boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)'
            }}
          />
        </div>
        
        <div className="mt-6 flex justify-center gap-4">
          <button 
            onClick={(e) => {
              console.log('New Game button clicked');
              e.preventDefault();
              resetGame();
            }}
            className="px-6 py-3 bg-amber-700 text-white rounded-lg hover:bg-amber-800 transition-colors font-semibold shadow-lg cursor-pointer"
          >
            New Game
          </button>
          {isThinking && (
            <div className="px-6 py-3 text-amber-700 font-semibold">
              Computer thinking...
            </div>
          )}
        </div>
      </div>

      <div className="bg-amber-100 p-6 rounded-lg shadow-2xl">
        <h2 className="text-2xl font-bold mb-4 text-amber-900">Commentary</h2>
        <div className="h-[600px] overflow-y-auto space-y-3">
          {commentary.length === 0 ? (
            <p className="text-amber-700 italic p-4">Make a move to hear the roast...</p>
          ) : (
            <div className="space-y-3">
              {commentary.map((comment, index) => (
                <div 
                  key={`${index}-${comment.commentary.substring(0, 10)}`} 
                  className={`p-4 bg-amber-50 rounded-lg border-2 border-amber-300 transition-all duration-500 ease-out ${
                    index === 0 ? 'animate-slide-in' : ''
                  }`}
                  style={{
                    opacity: index === 0 ? 0 : 1,
                    animation: index === 0 ? 'slideIn 0.5s ease-out forwards' : 'none'
                  }}
                >
                  <p className="text-amber-900 italic">{comment.commentary}</p>
                  {comment.audioUrl && (
                    <button 
                      onClick={() => playAudioManually(comment.audioUrl!)}
                      className="text-xs text-amber-600 hover:text-amber-800 mt-2 transition-colors"
                    >
                      🔊 Play Audio
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}