'use client';

import { useState, useEffect, useRef } from 'react';
import { Chess } from 'chess.js';
import axios from 'axios';
import dynamic from 'next/dynamic';

// Dynamic import for client-side only
const ChessboardComponent = dynamic(
  () => import('react-chessboard').then((mod) => mod.Chessboard),
  { ssr: false }
) as any;

interface Commentary {
  commentary: string;
  audioUrl?: string;
}

export default function ChessGame() {
  const [game, setGame] = useState(() => new Chess());
  const [moveHistory, setMoveHistory] = useState<string[]>([]);
  const [commentary, setCommentary] = useState<Commentary[]>([]);
  const [isThinking, setIsThinking] = useState(false);
  const audioQueueRef = useRef<string[]>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);

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

  const playNextAudio = () => {
    if (audioQueueRef.current.length > 0 && audioRef.current) {
      const nextUrl = audioQueueRef.current.shift();
      if (nextUrl) {
        audioRef.current.src = nextUrl;
        audioRef.current.play().catch(console.error);
        setIsPlaying(true);
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
      setCommentary(prev => [...prev, newCommentary]);
      
      if (newCommentary.audioUrl) {
        console.log('Playing audio:', newCommentary.audioUrl);
        addAudioToQueue(newCommentary.audioUrl);
      }
    } catch (error: any) {
      console.error('Error getting commentary:', error);
      console.error('Error details:', error.response?.data || error.message);
    }
  };

  const makeComputerMove = () => {
    const possibleMoves = game.moves();
    if (possibleMoves.length === 0) return;

    const randomIndex = Math.floor(Math.random() * possibleMoves.length);
    const move = possibleMoves[randomIndex];
    
    const gameCopy = new Chess(game.fen());
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
      
      // Send move to backend
      sendMoveToBackend(move.san, 'human');

      if (!gameCopy.isGameOver()) {
        setIsThinking(true);
        setTimeout(() => {
          makeComputerMove();
          setIsThinking(false);
        }, 1000);
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
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = '';
    }
    setIsPlaying(false);
  };

  return (
    <>
      <div className="bg-amber-100 p-6 rounded-lg shadow-2xl">
        <div className="w-full max-w-[600px] mx-auto">
          <ChessboardComponent 
            id="RoastedChessnutsBoard"
            position={game.fen()} 
            onPieceDrop={onDrop}
            arePiecesDraggable={true}
            boardWidth={560}
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
          {commentary.map((comment, index) => (
            <div key={index} className="p-4 bg-amber-50 rounded-lg border-2 border-amber-300">
              <p className="text-amber-900 italic">{comment.commentary}</p>
            </div>
          ))}
          {commentary.length === 0 && (
            <p className="text-amber-700 italic">Make a move to hear the roast...</p>
          )}
        </div>
      </div>
    </>
  );
}